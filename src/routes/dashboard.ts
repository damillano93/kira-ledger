import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { docRouteOptions } from '../docs/openapi.js';
import { DASHBOARD_HTML } from '../dashboard/page.js';

// Live operations dashboard: balances + live reconciliation, itemized fees,
// transfer state, and (when migration 004 lands) routing/outbound activity.
//
// READ-ONLY and intentionally UNAUTHENTICATED for this demo build so it can be
// projected during a walkthrough. In production this would sit behind the same
// authn middleware as /transfers (or an internal-only ingress) — it exposes
// balances, which are not public data.

// --- row shapes (pg returns BIGINT/NUMERIC as strings — never floats) --------

interface BalanceRow {
  id: string;
  name: string;
  kind: string;
  currency: string;
  available: string | null; // spend_guards.headroom_minor
  pending: string | null; // spend_guards.pending_minor
  entries_sum: string; // SUM(entries.amount), signed, debit-positive
}

interface FeeTotalRow {
  account_name: string;
  currency: string;
  total_minor: string;
  entry_count: string;
}

interface FeeEntryRow {
  entry_id: string;
  transfer_id: string;
  transfer_kind: string;
  amount_minor: string;
  currency: string;
  account_name: string;
  created_at: string;
}

interface TransferRow {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  gross_minor: string | null;
  currency: string | null;
}

// --- section loaders ----------------------------------------------------------

// Balances per account, with the ledger-derived balance alongside the guard so
// the recon invariant (ADR-004/ADR-020: guard is rebuildable from SUM(entries))
// is verified LIVE on every refresh, not just in an offline recon job.
//
// Sign convention: entries are debit-positive. user/fee accounts are
// liability-side (our claim TO the holder grows on a credit), so their derived
// balance is -SUM(entries); that is what must equal headroom + pending.
// external/asset mirrors carry no guard by design — they reconcile against
// chain/bank truth — so they are reported but excluded from the guard check.
//
// Ordered by created_at first so the seeded chart of accounts (migrations
// 002/003/004) is always inside the LIMIT window, no matter how many ad-hoc
// accounts accumulate later in a long-lived database.
async function loadBalances() {
  const res = await pool.query<BalanceRow>(
    `SELECT a.id, a.name, a.kind, a.currency,
            g.headroom_minor::text AS available,
            g.pending_minor::text  AS pending,
            COALESCE(e.total, 0)::text AS entries_sum
       FROM accounts a
       LEFT JOIN spend_guards g ON g.account_id = a.id
       LEFT JOIN (SELECT account_id, SUM(amount) AS total
                    FROM entries GROUP BY account_id) e ON e.account_id = a.id
      ORDER BY a.created_at, a.kind, a.name
      LIMIT 200`,
  );
  return res.rows.map((r) => {
    const tracked = r.kind === 'user' || r.kind === 'fee';
    const available = r.available ?? '0';
    const pending = r.pending ?? '0';
    const guardTotal = (BigInt(available) + BigInt(pending)).toString();
    const ledger = tracked
      ? (-BigInt(r.entries_sum)).toString() // liability-normal view
      : r.entries_sum; // raw signed sum for untracked mirrors
    return {
      accountId: r.id,
      name: r.name,
      kind: r.kind,
      currency: r.currency,
      available,
      pending,
      guardTotal,
      ledger,
      tracked,
      reconOk: tracked ? guardTotal === ledger : null,
    };
  });
}

// Fee entries are credits into kind='fee' accounts (negative, debit-positive
// convention), so fee REVENUE is -SUM(amount) / -amount.
async function loadFees() {
  const totals = await pool.query<FeeTotalRow>(
    `SELECT a.name AS account_name, e.currency,
            (-SUM(e.amount))::text AS total_minor,
            COUNT(*)::text AS entry_count
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
      WHERE a.kind = 'fee'
      GROUP BY a.name, e.currency
      ORDER BY a.name, e.currency`,
  );
  const recent = await pool.query<FeeEntryRow>(
    `SELECT e.id::text AS entry_id, e.transfer_id, t.kind AS transfer_kind,
            (-e.amount)::text AS amount_minor, e.currency,
            a.name AS account_name, e.created_at
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
       JOIN transfers t ON t.id = e.transfer_id
      WHERE a.kind = 'fee'
      ORDER BY e.id DESC
      LIMIT 15`,
  );
  return {
    totals: totals.rows.map((r) => ({
      accountName: r.account_name,
      currency: r.currency,
      totalMinor: r.total_minor,
      entryCount: r.entry_count,
    })),
    recent: recent.rows.map((r) => ({
      entryId: r.entry_id,
      transferId: r.transfer_id,
      transferKind: r.transfer_kind,
      amountMinor: r.amount_minor,
      currency: r.currency,
      accountName: r.account_name,
      createdAt: r.created_at,
    })),
  };
}

async function loadTransfers() {
  const res = await pool.query<TransferRow>(
    `SELECT t.id, t.kind, t.status, t.created_at,
            g.gross AS gross_minor, g.currency
       FROM transfers t
       LEFT JOIN LATERAL (
         SELECT (SUM(amount) FILTER (WHERE amount > 0))::text AS gross,
                MIN(currency) AS currency
           FROM entries WHERE transfer_id = t.id
       ) g ON true
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 50`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at,
    grossMinor: r.gross_minor,
    currency: r.currency,
  }));
}

// --- routing (migration 004, built by a parallel wave) -------------------------
// DEFENSIVE: those tables may not exist yet in this database. We discover any
// non-core public table via information_schema and render it generically, so
// this dashboard works today and lights up the routing section the moment the
// routing migration is applied — no code change needed here.

const CORE_TABLES = new Set(['accounts', 'transfers', 'entries', 'spend_guards']);
// Preferred ordering for known routing tables; anything else appends after.
const ROUTING_FIRST = ['route_executions', 'provider_statements'];

function stringifyCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function loadRouting() {
  const found = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const extras = found.rows
    .map((r) => r.table_name)
    .filter((t) => !CORE_TABLES.has(t));
  extras.sort((a, b) => {
    const ia = ROUTING_FIRST.indexOf(a);
    const ib = ROUTING_FIRST.indexOf(b);
    return (ia === -1 ? ROUTING_FIRST.length : ia) - (ib === -1 ? ROUTING_FIRST.length : ib);
  });

  const sections = [];
  for (const table of extras.slice(0, 6)) {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    const columns = cols.rows.map((c) => c.column_name);
    if (columns.length === 0) continue;
    // `table` comes from information_schema (a real table name), never from user
    // input; it is double-quoted to be identifier-safe regardless.
    const order = columns.includes('created_at')
      ? 'ORDER BY created_at DESC'
      : columns.includes('id')
        ? 'ORDER BY id DESC'
        : '';
    const rows = await pool.query(`SELECT * FROM "${table.replace(/"/g, '""')}" ${order} LIMIT 20`);
    sections.push({
      table,
      columns,
      rows: rows.rows.map((row: Record<string, unknown>) => {
        const out: Record<string, string | null> = {};
        for (const c of columns) out[c] = stringifyCell(row[c]);
        return out;
      }),
    });
  }
  return sections;
}

// --- routes -------------------------------------------------------------------

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  // The HTML shell. `hide` keeps demo-UI plumbing out of the OpenAPI spec.
  app.get(
    '/dashboard',
    { schema: { hide: true }, ...docRouteOptions },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.type('text/html; charset=utf-8').send(DASHBOARD_HTML);
    },
  );

  // The live data the shell polls. All amounts are integer minor units as
  // strings (same contract as the rest of the API — no floats anywhere).
  app.get(
    '/dashboard/data',
    { schema: { hide: true }, ...docRouteOptions },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const [balances, fees, transfers, routing] = await Promise.all([
        loadBalances(),
        loadFees(),
        loadTransfers(),
        loadRouting(),
      ]);
      return reply.send({
        generatedAt: new Date().toISOString(),
        balances,
        fees,
        transfers,
        routing,
      });
    },
  );
}
