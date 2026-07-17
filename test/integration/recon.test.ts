import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordDeposit } from '../../src/domain/offramp.js';
import type { EventLogger } from '../../src/observability/events.js';
import { runRecon } from '../../src/recon/recon.js';
import { registerReconRoutes } from '../../src/routes/recon.js';

// Reconciliation specs (DESIGN §9). The recon job's core promise is that a
// CLEAN ledger reconciles to `ok: true`, so these specs run against their OWN
// pristine database (created inside the same throwaway test container on 5433)
// instead of the shared `kira` test DB — other spec files legitimately leave
// fiat-seeded guard rows and forever-pending transfers behind, which recon
// would (correctly!) flag. Isolation makes both directions honest:
//   precision — a consistent world produces zero findings;
//   recall    — each seeded breakage is caught, and only that breakage.

const ADMIN_URL = 'postgres://kira:kira@localhost:5433/kira';
const RECON_DB = 'kira_recon';
const RECON_URL = `postgres://kira:kira@localhost:5433/${RECON_DB}`;

// Fixed UUIDs from migrations 002/004.
const NORTHWIND_USER = '00000000-0000-0000-0000-000000000002';
const ROASTER_DEST = '00000000-0000-0000-0000-000000000010';
const NORTHWIND_ROUTE = '00000000-0000-0000-0000-000000000100';

let db: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${RECON_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${RECON_DB}`);
  } finally {
    await admin.end();
  }

  db = new pg.Pool({ connectionString: RECON_URL });
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, '..', '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }
});

afterAll(async () => {
  await db.end();
});

// -- local helpers (bound to the recon pool, not the shared src/db pool) ------

async function withReconTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
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

async function createUserAccount(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO accounts (id, name, currency, kind) VALUES ($1, $2, 'USD', 'user')`, [
    id,
    `recon_user_${id.slice(0, 8)}`,
  ]);
  await db.query(`INSERT INTO spend_guards (account_id) VALUES ($1)`, [id]);
  return id;
}

async function createExternalAccount(currency: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO accounts (id, name, currency, kind) VALUES ($1, $2, $3, 'external')`, [
    id,
    `recon_external_${id.slice(0, 8)}`,
    currency,
  ]);
  return id;
}

// A bare transfer row (no entries) — used as an execution trigger fixture.
async function createBareTransfer(status: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO transfers (idempotency_key, kind, status) VALUES ($1, 'offramp', $2) RETURNING id`,
    [`recon-fixture-${randomUUID()}`, status],
  );
  return res.rows[0]!.id;
}

function captureLogger(): { events: Record<string, unknown>[]; logger: EventLogger } {
  const events: Record<string, unknown>[] = [];
  const push = (obj: object) => {
    events.push(obj as Record<string, unknown>);
  };
  return { events, logger: { info: push, warn: push, error: push } };
}

function refs(report: Awaited<ReturnType<typeof runRecon>>): string[] {
  return report.mismatches.map((m) => m.ref);
}

// -----------------------------------------------------------------------------

describe('reconciliation as a query (DESIGN §9)', () => {
  it('(a) a clean database reconciles ok: no mismatches, ok=true', async () => {
    const report = await runRecon(db);
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(typeof report.runAt).toBe('string');
    expect(report.maxAgeMinutes).toBe(60);
    // migrations seed guarded user/fee accounts; nothing else exists yet
    expect(report.checked.guardedAccounts).toBeGreaterThan(0);
    expect(report.checked.chainStatements).toBe(0);
    expect(report.checked.providerStatements).toBe(0);
  });

  it('(a) precision: matched statements, settled legs and confirmed deposits are NOT flagged', async () => {
    // A chain event WITH its ledger deposit (the watcher's normal outcome),
    // aged well past SLA and credited — recon must stay silent about it.
    const external = await createExternalAccount('USDC');
    const user = await createUserAccount();
    const signature = `sig-matched-${randomUUID()}`;
    await db.query(
      `INSERT INTO chain_events (chain, signature, amount_minor, currency, mint, slot, status, seen_at)
       VALUES ('solana-devnet', $1, 5000000000, 'USDC', 'mint', 100, 'credited', now() - interval '3 hours')`,
      [signature],
    );
    const deposit = await withReconTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `solana-devnet:${signature}`,
        externalAccountId: external,
        userAccountId: user,
        amount: 5_000_000_000n,
        currency: 'USDC',
      }),
    );
    await db.query(`UPDATE transfers SET status = 'confirmed', created_at = now() - interval '3 hours' WHERE id = $1`, [
      deposit.transfer.id,
    ]);
    // Drain pending so the guard matches the (single-entry-pair) ledger state.
    // (In production the offramp transfer does this; here we keep the fixture
    // minimal: guard pending == -SUM(entries) already holds after recordDeposit.)

    // A provider statement WITH its settled leg and confirmed transfer.
    const trigger = await createBareTransfer('confirmed');
    const execution = await db.query<{ id: string }>(
      `INSERT INTO route_executions (route_id, trigger_transfer_id, status)
       VALUES ($1, $2, 'completed') RETURNING id`,
      [NORTHWIND_ROUTE, trigger],
    );
    const legTransfer = await createBareTransfer('confirmed');
    const externalRef = `acme-matched-${randomUUID()}`;
    await db.query(
      `INSERT INTO route_legs (execution_id, seq, provider, status, idempotency_key, external_ref,
                               transfer_id, user_account_id, destination_account_id,
                               amount_minor, currency, source_amount_minor, source_currency)
       VALUES ($1, 1, 'acmepay', 'settled', $2, $3, $4, $5, $6, 420000, 'USD', 420000, 'USD')`,
      [execution.rows[0]!.id, `route-${randomUUID()}`, externalRef, legTransfer, NORTHWIND_USER, ROASTER_DEST],
    );
    await db.query(
      `INSERT INTO provider_statements (provider, external_ref, amount_minor, currency)
       VALUES ('acmepay', $1, 420000, 'USD')`,
      [externalRef],
    );

    const report = await runRecon(db);
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it('(b) settled-with-no-entry: orphan chain events and provider statements are caught', async () => {
    const orphanSignature = `sig-orphan-${randomUUID()}`;
    const orphanRef = `acme-orphan-${randomUUID()}`;

    // The world moved money we never recorded: a statement row on each rail
    // with no ledger transfer behind it (missed webhook / watcher gap).
    await db.query(
      `INSERT INTO chain_events (chain, signature, amount_minor, currency, mint, slot, status)
       VALUES ('solana-devnet', $1, 123456, 'USDC', 'mint', 200, 'detected')`,
      [orphanSignature],
    );
    await db.query(
      `INSERT INTO provider_statements (provider, external_ref, amount_minor, currency)
       VALUES ('acmepay', $1, 42000, 'USD')`,
      [orphanRef],
    );

    const { events, logger } = captureLogger();
    const report = await runRecon(db, { logger });

    expect(report.ok).toBe(false);
    const chainFinding = report.mismatches.find((m) => m.ref === orphanSignature);
    expect(chainFinding).toMatchObject({
      type: 'settled_no_entry',
      side: 'chain:solana-devnet',
      amountMinor: '123456',
      currency: 'USDC',
    });
    const providerFinding = report.mismatches.find((m) => m.ref === orphanRef);
    expect(providerFinding).toMatchObject({
      type: 'settled_no_entry',
      side: 'provider:acmepay',
      amountMinor: '42000',
      currency: 'USD',
    });
    // exactly these two — the consistent world from (a) stays silent
    expect(report.mismatches).toHaveLength(2);

    // one recon.* event per finding, through the observability vocabulary
    const emitted = events.filter((e) => e['event'] === 'recon.mismatch.settled_no_entry');
    expect(emitted.map((e) => e['externalId'])).toEqual(
      expect.arrayContaining([orphanSignature, orphanRef]),
    );

    // clean up (statement tables carry no append-only trigger)
    await db.query(`DELETE FROM chain_events WHERE signature = $1`, [orphanSignature]);
    await db.query(`DELETE FROM provider_statements WHERE external_ref = $1`, [orphanRef]);
  });

  it('(c) entry-never-confirmed: aged pending transfers and stuck legs are caught; young or cleared ones are not', async () => {
    // 1. An aged pending deposit with NO external confirmation — stuck intent.
    const external = await createExternalAccount('USD');
    const user = await createUserAccount();
    const stuck = await withReconTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `manual-hook:${randomUUID()}`,
        externalAccountId: external,
        userAccountId: user,
        amount: 90_000n,
        currency: 'USD',
      }),
    );
    await db.query(`UPDATE transfers SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      stuck.transfer.id,
    ]);

    // 2. A YOUNG pending deposit — in flight, must not be flagged.
    const young = await withReconTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `manual-hook:${randomUUID()}`,
        externalAccountId: external,
        userAccountId: user,
        amount: 10_000n,
        currency: 'USD',
      }),
    );

    // 3. An aged pending deposit whose chain event DID reach 'credited' — a
    //    late confirmation, cleared by the anti-join, never flagged.
    const clearedSig = `sig-cleared-${randomUUID()}`;
    await db.query(
      `INSERT INTO chain_events (chain, signature, amount_minor, currency, mint, slot, status)
       VALUES ('solana-devnet', $1, 70000, 'USD', 'mint', 300, 'credited')`,
      [clearedSig],
    );
    const cleared = await withReconTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `solana-devnet:${clearedSig}`,
        externalAccountId: external,
        userAccountId: user,
        amount: 70_000n,
        currency: 'USD',
      }),
    );
    await db.query(`UPDATE transfers SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      cleared.transfer.id,
    ]);

    // 4. An aged initiated route leg with NO provider statement — the provider
    //    acked and went silent (the C4 window). Its reservation transfer is
    //    excluded from the transfer check (the leg owns the finding).
    const trigger = await createBareTransfer('confirmed');
    const execution = await db.query<{ id: string }>(
      `INSERT INTO route_executions (route_id, trigger_transfer_id, status)
       VALUES ($1, $2, 'reserved') RETURNING id`,
      [NORTHWIND_ROUTE, trigger],
    );
    const legTransfer = await createBareTransfer('pending');
    const legRef = `acme-stuck-${randomUUID()}`;
    const leg = await db.query<{ id: string }>(
      `INSERT INTO route_legs (execution_id, seq, provider, status, idempotency_key, external_ref,
                               transfer_id, user_account_id, destination_account_id,
                               amount_minor, currency, source_amount_minor, source_currency, created_at)
       VALUES ($1, 1, 'acmepay', 'initiated', $2, $3, $4, $5, $6,
               420000, 'USD', 420000, 'USD', now() - interval '2 hours')
       RETURNING id`,
      [execution.rows[0]!.id, `route-${randomUUID()}`, legRef, legTransfer, NORTHWIND_USER, ROASTER_DEST],
    );
    const legId = leg.rows[0]!.id;
    await db.query(`UPDATE transfers SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      legTransfer,
    ]);

    const { events, logger } = captureLogger();
    const report = await runRecon(db, { maxAgeMinutes: 60, logger });

    expect(report.ok).toBe(false);
    const stuckFinding = report.mismatches.find((m) => m.ref === stuck.transfer.id);
    expect(stuckFinding).toMatchObject({
      type: 'entry_never_confirmed',
      side: 'ledger:transfer',
      amountMinor: '90000',
      currency: 'USD',
    });
    expect(stuckFinding!.ageMinutes).toBeGreaterThanOrEqual(119);

    const legFinding = report.mismatches.find((m) => m.ref === legId);
    expect(legFinding).toMatchObject({
      type: 'entry_never_confirmed',
      side: 'ledger:route_leg',
      amountMinor: '420000',
      currency: 'USD',
    });

    // the young deposit, the late-confirmed deposit and the leg's own
    // reservation transfer are all absent
    expect(refs(report)).not.toContain(young.transfer.id);
    expect(refs(report)).not.toContain(cleared.transfer.id);
    expect(refs(report)).not.toContain(legTransfer);
    expect(report.mismatches).toHaveLength(2);

    const emitted = events.filter((e) => e['event'] === 'recon.mismatch.entry_never_confirmed');
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e['transferId'])).toEqual(
      expect.arrayContaining([stuck.transfer.id, legTransfer]),
    );

    // resolve the seeded breakage so later specs start from a reconciled world
    // (status flips are how the real flows resolve; entries are never touched)
    await db.query(`UPDATE transfers SET status = 'confirmed' WHERE id = ANY($1::uuid[])`, [
      [stuck.transfer.id, young.transfer.id, legTransfer],
    ]);
    await db.query(`UPDATE route_legs SET status = 'failed' WHERE id = $1`, [legId]);
  });

  it('(d) balance drift: a spend_guard that disagrees with SUM(entries) is caught with the exact drift', async () => {
    const external = await createExternalAccount('USD');
    const user = await createUserAccount();
    const deposit = await withReconTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `manual-hook:${randomUUID()}`,
        externalAccountId: external,
        userAccountId: user,
        amount: 50_000n,
        currency: 'USD',
      }),
    );
    await db.query(`UPDATE transfers SET status = 'confirmed' WHERE id = $1`, [deposit.transfer.id]);

    // consistent so far: guard pending=50000 == -SUM(entries)
    const before = await runRecon(db);
    expect(refs(before)).not.toContain(user);

    // break the guard by hand — the ADR-020 "rebuildable" promise violated
    await db.query(
      `UPDATE spend_guards SET headroom_minor = headroom_minor + 7 WHERE account_id = $1`,
      [user],
    );

    const { events, logger } = captureLogger();
    const report = await runRecon(db, { logger });

    expect(report.ok).toBe(false);
    const finding = report.mismatches.find((m) => m.ref === user);
    expect(finding).toMatchObject({
      type: 'balance_drift',
      side: 'ledger:spend_guard',
      amountMinor: '7', // guard says 50007, entries rebuild to 50000
      currency: 'USD',
      ageMinutes: null,
    });
    expect(report.mismatches).toHaveLength(1);

    const emitted = events.filter((e) => e['event'] === 'recon.balance_drift');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      accountId: user,
      guardMinor: '50007',
      entriesMinor: '50000',
      driftMinor: '7',
    });

    // restore the guard (the counter is rebuildable state, not the ledger)
    await db.query(
      `UPDATE spend_guards SET headroom_minor = headroom_minor - 7 WHERE account_id = $1`,
      [user],
    );
    const after = await runRecon(db);
    expect(after.ok).toBe(true);
  });

  it('GET /recon/report: requires the API key and returns the JSON report', async () => {
    const app = Fastify();
    await registerReconRoutes(app, { db });
    try {
      const unauthorized = await app.inject({ method: 'GET', url: '/recon/report' });
      expect(unauthorized.statusCode).toBe(401);

      const badQuery = await app.inject({
        method: 'GET',
        url: '/recon/report?maxAgeMinutes=nope',
        headers: { 'x-api-key': 'test-api-key' },
      });
      expect(badQuery.statusCode).toBe(400);

      const res = await app.inject({
        method: 'GET',
        url: '/recon/report?maxAgeMinutes=45',
        headers: { 'x-api-key': 'test-api-key' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; maxAgeMinutes: number; mismatches: unknown[] };
      expect(body.maxAgeMinutes).toBe(45);
      expect(body.ok).toBe(true); // (c)/(d) resolved their seeded breakage
      expect(body.mismatches).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
