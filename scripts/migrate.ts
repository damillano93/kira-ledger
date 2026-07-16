import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

// Apply every migrations/*.sql file in lexical order. Each file is written to be
// idempotent, so this is safe to run on every container boot.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

async function run(): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    process.stdout.write(`applying ${file} ...\n`);
    await pool.query(sql);
  }

  process.stdout.write(`applied ${files.length} migration(s)\n`);
  await pool.end();
}

run().catch((err) => {
  process.stderr.write(`migration failed: ${String(err)}\n`);
  process.exit(1);
});
