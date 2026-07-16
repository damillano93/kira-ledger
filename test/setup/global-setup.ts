import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Self-contained DB bring-up for the whole suite.
//
// The docker-compose `db` service binds host port 5432, which is already taken on
// dev machines, so tests use a DEDICATED throwaway container on 5433 (image
// postgres:13-alpine, which supports everything the schema needs: pgcrypto,
// DEFERRABLE constraint triggers and CHECK constraints). Migrations are applied
// here, once, before any spec runs.

const TEST_DB_URL = 'postgres://kira:kira@localhost:5433/kira';
const CONTAINER = 'kira-ledger-test-db';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function containerRunning(): boolean {
  try {
    return sh(`docker ps --filter name=^/${CONTAINER}$ --format '{{.Names}}'`) === CONTAINER;
  } catch {
    return false;
  }
}

function ensureContainer(): void {
  if (containerRunning()) return;
  // Remove any stopped remnant, then start fresh.
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
  } catch {
    /* nothing to remove */
  }
  execSync(
    `docker run -d --name ${CONTAINER} ` +
      `-e POSTGRES_USER=kira -e POSTGRES_PASSWORD=kira -e POSTGRES_DB=kira ` +
      `-p 5433:5432 postgres:13-alpine`,
    { stdio: 'ignore' },
  );
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 45_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const client = new pg.Client({ connectionString: TEST_DB_URL });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw new Error('test database never became ready');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      await pool.query(readFileSync(join(migrationsDir, file), 'utf8'));
    }
  } finally {
    await pool.end();
  }
}

export async function setup(): Promise<void> {
  process.env.DATABASE_URL = TEST_DB_URL;
  ensureContainer();
  await waitReady();
  await migrate();
}

// Leave the container running between runs for fast iteration; nothing to tear down.
export async function teardown(): Promise<void> {}
