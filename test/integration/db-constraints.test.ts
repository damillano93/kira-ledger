import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { createBalancedTransfer } from '../../src/domain/ledger.js';
import { confirmOfframp, recordDeposit } from '../../src/domain/offramp.js';
import { createAccount, getBalance } from '../helpers/db.js';

// NOTE: the `pool` from src/db.js is a process-wide singleton shared across all
// spec files (single fork). Never end it here — vitest terminates the fork.

describe('the DATABASE enforces the invariants structurally (not by convention)', () => {
  it('(a) an unbalanced transfer is rejected by the DEFERRED trigger at COMMIT', async () => {
    const acct = await createAccount('user');
    const client = await pool.connect();
    let threw: unknown;
    try {
      await client.query('BEGIN');
      const t = await client.query<{ id: string }>(
        `INSERT INTO transfers (idempotency_key, kind, status)
         VALUES ($1, 'payout', 'pending') RETURNING id`,
        [`raw-unbalanced-${randomUUID()}`],
      );
      const transferId = t.rows[0]!.id;
      // A single entry that does NOT net to zero. The row inserts fine; the
      // constraint trigger is DEFERRED so the violation only fires at COMMIT.
      await client.query(
        `INSERT INTO entries (transfer_id, account_id, amount, currency) VALUES ($1, $2, $3, 'USD')`,
        [transferId, acct.id, '100'],
      );
      await client.query('COMMIT'); // <-- expected to blow up here
    } catch (err) {
      threw = err;
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    expect(threw).toBeInstanceOf(Error);
    expect(String(threw)).toMatch(/unbalanced/i);
  });

  it('(b) a write that would drive headroom_minor < 0 is rejected by CHECK (headroom_minor >= 0)', async () => {
    const acct = await createAccount('user', { available: 500n });
    let threw: unknown;
    try {
      await pool.query(
        `UPDATE spend_guards SET headroom_minor = headroom_minor - $1 WHERE account_id = $2`,
        ['600', acct.id],
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    // Postgres check_violation
    expect((threw as { code?: string }).code).toBe('23514');
    const bal = await getBalance(acct.id);
    expect(bal?.available).toBe(500n); // untouched
  });

  it('(c) the same idempotency_key cannot duplicate (UNIQUE + ON CONFLICT => single effect)', async () => {
    const user = await createAccount('user', { available: 1_000n });
    const dest = await createAccount('external');
    const key = `idem-${randomUUID()}`;

    const first = await withTx((c) =>
      createBalancedTransfer(c, {
        idempotencyKey: key,
        kind: 'payout',
        postings: [
          { accountId: user.id, amount: 200n, currency: 'USD', balance: { bucket: 'available', delta: -200n } },
          { accountId: dest.id, amount: -200n, currency: 'USD' },
        ],
      }),
    );
    const second = await withTx((c) =>
      createBalancedTransfer(c, {
        idempotencyKey: key,
        kind: 'payout',
        postings: [
          { accountId: user.id, amount: 200n, currency: 'USD', balance: { bucket: 'available', delta: -200n } },
          { accountId: dest.id, amount: -200n, currency: 'USD' },
        ],
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transfer.id).toBe(first.transfer.id); // same stored transfer

    // Only ONE debit was applied despite two calls.
    const bal = await getBalance(user.id);
    expect(bal?.available).toBe(800n);

    // A raw duplicate INSERT (no ON CONFLICT) hits the UNIQUE constraint directly.
    let threw: unknown;
    try {
      await pool.query(`INSERT INTO transfers (idempotency_key, kind) VALUES ($1, 'payout')`, [key]);
    } catch (err) {
      threw = err;
    }
    expect((threw as { code?: string }).code).toBe('23505'); // unique_violation
  });
});

describe('off-ramp: fees are itemised, pending -> available nets correctly', () => {
  it('confirmOfframp moves pending->available minus fee, and the fee account receives the fee', async () => {
    const external = await createAccount('external');
    const user = await createAccount('user');
    const fee = await createAccount('fee');

    const gross = 100_000n; // minor units
    const feeAmount = 2_500n;
    const net = gross - feeAmount;

    // 1. Deposit is booked to PENDING only; available stays 0.
    const deposit = await withTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `dep-${randomUUID()}`,
        externalAccountId: external.id,
        userAccountId: user.id,
        amount: gross,
        currency: 'USD',
      }),
    );
    let userBal = await getBalance(user.id);
    expect(userBal).toEqual({ pending: gross, available: 0n });

    // 2. Confirm: pending drains, net lands in available, fee is itemised to fee acct.
    await withTx((c) =>
      confirmOfframp(c, {
        idempotencyKey: `off-${randomUUID()}`,
        depositTransferId: deposit.transfer.id,
        userAccountId: user.id,
        feeAccountId: fee.id,
        amount: gross,
        feeAmount,
        currency: 'USD',
      }),
    );

    userBal = await getBalance(user.id);
    expect(userBal).toEqual({ pending: 0n, available: net });

    const feeBal = await getBalance(fee.id);
    expect(feeBal?.available).toBe(feeAmount);

    // available(user) + fee == gross : nothing created or destroyed.
    expect(userBal!.available + feeBal!.available).toBe(gross);
  });
});
