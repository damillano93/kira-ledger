import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;

export const pool = new Pool({ connectionString: config.DATABASE_URL });

// Run `fn` inside a single transaction. Commits on success, rolls back on throw.
// The deferred double-entry constraint trigger fires at COMMIT, so an unbalanced
// set of entries surfaces here as a rejected promise.
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Liveness/readiness probe against the database.
export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}
