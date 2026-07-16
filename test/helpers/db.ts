import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db.js';

// Shared helpers for integration/concurrency specs. Each test mints its OWN
// accounts with random UUIDs so specs are isolated without truncating a shared DB.

export interface TestAccount {
  id: string;
  kind: string;
  currency: string;
}

// Create an account. `user` and `fee` kinds materialise a balances row; external
// / asset mirrors intentionally do NOT (their spendable buckets aren't tracked).
export async function createAccount(
  kind: 'user' | 'fee' | 'external' | 'asset' | 'liability',
  opts: { available?: bigint; pending?: bigint; currency?: string } = {},
): Promise<TestAccount> {
  const id = randomUUID();
  const currency = opts.currency ?? 'USD';
  await pool.query(`INSERT INTO accounts (id, name, currency, kind) VALUES ($1, $2, $3, $4)`, [
    id,
    `test_${kind}_${id.slice(0, 8)}`,
    currency,
    kind,
  ]);
  if (kind === 'user' || kind === 'fee') {
    await pool.query(
      `INSERT INTO spend_guards (account_id, headroom_minor, pending_minor) VALUES ($1, $2, $3)`,
      [id, (opts.available ?? 0n).toString(), (opts.pending ?? 0n).toString()],
    );
  }
  return { id, kind, currency };
}

export async function getBalance(
  accountId: string,
): Promise<{ available: bigint; pending: bigint } | null> {
  const res = await pool.query<{ available: string; pending: string }>(
    `SELECT headroom_minor AS available, pending_minor AS pending FROM spend_guards WHERE account_id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { available: BigInt(row.available), pending: BigInt(row.pending) };
}

export async function countEntries(transferIdempotencyKey: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM entries e
       JOIN transfers t ON t.id = e.transfer_id
      WHERE t.idempotency_key = $1`,
    [transferIdempotencyKey],
  );
  return Number(res.rows[0]?.n ?? '0');
}
