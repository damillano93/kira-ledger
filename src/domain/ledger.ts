import type { PoolClient } from '../db.js';

// A ledger posting. `amount` is the signed minor-unit value written to the
// append-only `entries` table (debits positive, credits negative), and per
// transfer per currency these MUST net to zero — the database enforces it.
//
// `balance` is the optional materialised effect on the spend_guards reservation
// counter (ADR-004/ADR-020 — not a stored balance; see migration). It is kept
// separate from the entry sign because balance normal-sides differ by account
// kind (a liability's claim grows on a credit). External/asset-mirror accounts
// carry no `balance` effect: their spendable buckets are not tracked here, they
// are reconciled against chain/bank truth.
export interface Posting {
  accountId: string;
  amount: bigint;
  currency: string;
  balance?: { bucket: Bucket; delta: bigint };
}

export type Bucket = 'available' | 'pending';

export type TransferKind = 'deposit' | 'offramp' | 'payout';
export type TransferStatus = 'pending' | 'confirmed' | 'failed';

export interface TransferRecord {
  id: string;
  idempotency_key: string;
  kind: TransferKind;
  status: TransferStatus;
  created_at: string;
}

export interface CreateTransferInput {
  idempotencyKey: string;
  kind: TransferKind;
  status?: TransferStatus;
  postings: Posting[];
}

export interface CreateTransferResult {
  transfer: TransferRecord;
  // false when the idempotency key already existed: no new entries/balances were
  // written and the previously-stored transfer is returned unchanged.
  created: boolean;
}

export class InsufficientFundsError extends Error {
  constructor(public readonly accountId: string) {
    super(`insufficient available funds for account ${accountId}`);
    this.name = 'InsufficientFundsError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';

// Create a balanced, idempotent transfer. Must be called inside withTx().
export async function createBalancedTransfer(
  client: PoolClient,
  input: CreateTransferInput,
): Promise<CreateTransferResult> {
  const { idempotencyKey, kind, status = 'pending', postings } = input;

  // Defensive application-side check (the DB trigger is the real guardrail).
  assertBalanced(postings);

  // Idempotency guardrail: insert the transfer, and if the unique key already
  // exists do nothing and return the stored row — never re-post entries.
  const inserted = await client.query<TransferRecord>(
    `INSERT INTO transfers (idempotency_key, kind, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [idempotencyKey, kind, status],
  );

  if (inserted.rows.length === 0) {
    const existing = await client.query<TransferRecord>(
      `SELECT * FROM transfers WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) {
      // Extremely unlikely race; surface it rather than returning undefined.
      throw new Error(`idempotency key ${idempotencyKey} vanished after conflict`);
    }
    return { transfer: row, created: false };
  }

  const transfer = inserted.rows[0]!;

  for (const posting of postings) {
    await client.query(
      `INSERT INTO entries (transfer_id, account_id, amount, currency)
       VALUES ($1, $2, $3, $4)`,
      [transfer.id, posting.accountId, posting.amount.toString(), posting.currency],
    );
    if (posting.balance) {
      await applyBalance(client, posting.accountId, posting.balance);
    }
  }

  return { transfer, created: true };
}

export async function setTransferStatus(
  client: PoolClient,
  transferId: string,
  status: TransferStatus,
): Promise<void> {
  await client.query(`UPDATE transfers SET status = $1 WHERE id = $2`, [status, transferId]);
}

// Apply a single materialised balance effect.
// A negative delta on the `available` bucket is a spend: it uses SELECT ... FOR
// UPDATE to serialise concurrent payouts, then a conditional UPDATE that only
// succeeds while headroom_minor >= amount. Zero rows affected => insufficient
// funds. The CHECK (headroom_minor >= 0) constraint is the last-resort backstop.
async function applyBalance(
  client: PoolClient,
  accountId: string,
  effect: { bucket: Bucket; delta: bigint },
): Promise<void> {
  await client.query(
    `INSERT INTO spend_guards (account_id) VALUES ($1)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );

  const { bucket, delta } = effect;

  if (bucket === 'available' && delta < 0n) {
    const need = (-delta).toString();
    await client.query(`SELECT 1 FROM spend_guards WHERE account_id = $1 FOR UPDATE`, [
      accountId,
    ]);
    const res = await client.query(
      `UPDATE spend_guards
         SET headroom_minor = headroom_minor - $1, updated_at = now()
       WHERE account_id = $2 AND headroom_minor >= $1`,
      [need, accountId],
    );
    if (res.rowCount === 0) {
      throw new InsufficientFundsError(accountId);
    }
    return;
  }

  // `bucket` is a typed union, never user input — safe to interpolate.
  const column = bucket === 'available' ? 'headroom_minor' : 'pending_minor';
  await client.query(
    `UPDATE spend_guards
       SET ${column} = ${column} + $1, updated_at = now()
     WHERE account_id = $2`,
    [delta.toString(), accountId],
  );
}

export interface PayoutInput {
  idempotencyKey: string;
  userAccountId: string; // client account whose available funds are spent
  destinationAccountId: string; // external destination mirror
  amount: bigint;
  currency: string;
}

// Outbound payout: atomically reserve funds from the client's available balance
// and post the balanced entries. The debit only commits while available >= amount
// (guarded UPDATE inside applyBalance), so concurrent payouts cannot double-spend
// and the balance can never go negative. Idempotent per idempotency key.
export async function createPayout(
  client: PoolClient,
  input: PayoutInput,
): Promise<CreateTransferResult> {
  const { idempotencyKey, userAccountId, destinationAccountId, amount, currency } = input;
  if (amount <= 0n) throw new Error('payout amount must be positive');

  const postings: Posting[] = [
    // Debit the client's available bucket (guarded, no-negative).
    {
      accountId: userAccountId,
      amount: amount,
      currency,
      balance: { bucket: 'available', delta: -amount },
    },
    // Credit the external destination mirror (no materialised bucket).
    { accountId: destinationAccountId, amount: -amount, currency },
  ];

  return createBalancedTransfer(client, {
    idempotencyKey,
    kind: 'payout',
    status: 'pending',
    postings,
  });
}

function assertBalanced(postings: Posting[]): void {
  const totals = new Map<string, bigint>();
  for (const p of postings) {
    totals.set(p.currency, (totals.get(p.currency) ?? 0n) + p.amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new Error(`unbalanced postings for currency ${currency}: sum=${total}`);
    }
  }
}
