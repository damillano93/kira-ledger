import { config } from '../config.js';
import { pool, withTx } from '../db.js';
import {
  CONVERSION_ACCOUNT_ID,
  confirmOfframpConverted,
  recordDeposit,
  type ConversionQuote,
} from '../domain/offramp.js';
import { emitLedgerEvent, type EventLogger } from '../observability/events.js';
import { parseSplDeposit } from './parser.js';
import { createSolanaRpc, deriveDepositAta, type ChainRpc, type SignatureStatusView } from './rpc.js';

// In-process Solana devnet deposit watcher (DESIGN §7 "chain watchers" worker).
//
// Two phases per tick, mirroring the §5 inbound machine:
//   DETECT  ('confirmed' commitment): new signatures on the deposit ATA are
//            parsed and booked as PENDING deposits — seen, not spendable.
//   CONFIRM ('finalized' OR slot-depth >= CONFIRMATIONS): the pending USDC is
//            drained and USD lands in AVAILABLE minus itemised fees (ADR-007:
//            credit at chain confirmation), via confirmOfframpConverted.
//
// Idempotency is Postgres rows, never process memory (ADR-011):
//   * chain_events UNIQUE(chain, signature) — re-scans and restarts are no-ops.
//   * The deposit's transfer idempotency key is `${CHAIN}:${signature}` — the
//     SAME shape the /webhooks/chain route derives (`${chain}:${txHash}`), so
//     watcher and webhook dedupe AGAINST EACH OTHER: whoever loses the insert
//     race becomes a no-op on the ledger.
//   * detected -> credited is a guarded UPDATE (rowcount 0 => someone else won).

export const CHAIN = 'solana-devnet';

// How many recent signatures to re-scan per tick. There is no persisted cursor:
// dedupe by (chain, signature) makes overlap re-scanning harmless (DESIGN §8),
// and on devnet demo volumes a fixed window is simpler than cursor management.
const SIGNATURE_SCAN_LIMIT = 100;

// Backoff cap for consecutive RPC failures — devnet is flaky and rate-limited;
// the watcher slows down and keeps living, it never takes the process down.
const MAX_BACKOFF_MS = 5 * 60_000;

export interface WatcherLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OfframpConfirmedEvent {
  chain: string;
  signature: string;
  depositTransferId: string;
  offrampTransferId: string;
  userAccountId: string;
  quote: ConversionQuote;
}

// Routing hook (built by another module in parallel): the watcher stays
// decoupled — if a callback is registered it fires AFTER the credit commits;
// if not, the confirmation is just logged. Route-firing idempotency is the
// routing module's own UNIQUE(route_id, trigger_transfer_id) (DESIGN §6 R4),
// so an at-most-once, post-commit hook here is safe.
type OfframpConfirmedHook = (event: OfframpConfirmedEvent) => void | Promise<void>;
let onOfframpConfirmed: OfframpConfirmedHook | null = null;

export function setOnOfframpConfirmed(hook: OfframpConfirmedHook | null): void {
  onOfframpConfirmed = hook;
}

export interface WatcherOptions {
  rpc?: ChainRpc;
  mint?: string; // SPL mint to watch (config.SOLANA_USDC_MINT)
  depositOwner?: string; // wallet whose ATA receives deposits
  confirmations?: number; // slot-depth threshold when not yet finalized
  feeBps?: number;
  pollMs?: number;
  // Ledger accounts for the flow; default to the seeded chart (002/003 migrations).
  externalAccountId?: string; // USDC external mirror (source of funds)
  userAccountId?: string; // client sub-account credited
  feeAccountId?: string;
  conversionAccountId?: string;
  logger?: WatcherLogger;
  // Structured business-event sink (observability/events.ts). server.ts passes
  // app.log (pino satisfies EventLogger structurally); when absent, events are
  // serialised through the plain WatcherLogger so tests stay silent with their
  // silent logger and standalone runs still get one JSON line per event.
  events?: EventLogger;
}

interface ResolvedOptions {
  rpc: ChainRpc;
  mint: string;
  depositOwner: string;
  depositAta: string;
  confirmations: number;
  feeBps: number;
  pollMs: number;
  externalAccountId: string;
  userAccountId: string;
  feeAccountId: string;
  conversionAccountId: string;
  logger: WatcherLogger;
  events: EventLogger;
}

// Seeded accounts from migration 002 — the Northwind demo flow.
const DEFAULT_EXTERNAL_USDC = '00000000-0000-0000-0000-000000000001';
const DEFAULT_USER_ACCOUNT = '00000000-0000-0000-0000-000000000002';
const DEFAULT_FEE_ACCOUNT = '00000000-0000-0000-0000-000000000003';

// Fallback event sink: route structured events through the watcher's plain
// string logger (one JSON line, same grep-able shape pino would produce).
function eventsFromWatcherLogger(logger: WatcherLogger): EventLogger {
  const line = (obj: object, msg?: string) => `${msg ?? ''} ${JSON.stringify(obj)}`;
  return {
    info: (obj, msg) => logger.info(line(obj, msg)),
    warn: (obj, msg) => logger.warn(line(obj, msg)),
    error: (obj, msg) => logger.error(line(obj, msg)),
  };
}

function resolve(options: WatcherOptions): ResolvedOptions {
  const mint = options.mint ?? config.SOLANA_USDC_MINT;
  const depositOwner = options.depositOwner ?? config.SOLANA_DEPOSIT_OWNER;
  if (!mint || !depositOwner) {
    throw new Error(
      'chain watcher requires SOLANA_USDC_MINT and SOLANA_DEPOSIT_OWNER (run scripts/devnet-setup.ts to generate them)',
    );
  }
  const logger = options.logger ?? {
    info: (m) => console.log(`[chain-watcher] ${m}`),
    warn: (m) => console.warn(`[chain-watcher] ${m}`),
    error: (m) => console.error(`[chain-watcher] ${m}`),
  };
  return {
    rpc: options.rpc ?? createSolanaRpc(config.SOLANA_RPC_URL),
    mint,
    depositOwner,
    depositAta: deriveDepositAta(mint, depositOwner),
    confirmations: options.confirmations ?? config.CONFIRMATIONS,
    feeBps: options.feeBps ?? config.OFFRAMP_FEE_BPS,
    pollMs: options.pollMs ?? config.WATCHER_POLL_MS,
    externalAccountId: options.externalAccountId ?? DEFAULT_EXTERNAL_USDC,
    userAccountId: options.userAccountId ?? DEFAULT_USER_ACCOUNT,
    feeAccountId: options.feeAccountId ?? DEFAULT_FEE_ACCOUNT,
    conversionAccountId: options.conversionAccountId ?? CONVERSION_ACCOUNT_ID,
    logger,
    events: options.events ?? eventsFromWatcherLogger(logger),
  };
}

// --- Phase 1: DETECT ---------------------------------------------------------

async function detectDeposits(opts: ResolvedOptions): Promise<void> {
  const { rpc, logger } = opts;

  const infos = await rpc.getSignaturesForAddress(opts.depositAta, SIGNATURE_SCAN_LIMIT);
  const candidates = infos.filter((i) => i.err === null || i.err === undefined);
  if (candidates.length === 0) return;

  // Skip signatures we already persisted — one SELECT instead of N tx fetches.
  const known = await pool.query<{ signature: string }>(
    `SELECT signature FROM chain_events WHERE chain = $1 AND signature = ANY($2::text[])`,
    [CHAIN, candidates.map((c) => c.signature)],
  );
  const knownSet = new Set(known.rows.map((r) => r.signature));

  for (const info of candidates) {
    if (knownSet.has(info.signature)) continue;
    try {
      const tx = await rpc.getParsedTransaction(info.signature);
      if (!tx) continue; // not yet queryable at this commitment; next tick retries
      const deposit = parseSplDeposit(tx, { mint: opts.mint, owner: opts.depositOwner });
      if (!deposit) continue; // failed tx, outbound movement, or unrelated mint

      let depositTransferId: string | null = null;
      await withTx(async (client) => {
        // Insert-first dedupe: only the winning insert posts the ledger deposit.
        const inserted = await client.query(
          `INSERT INTO chain_events (chain, signature, amount_minor, currency, mint, slot, status)
           VALUES ($1, $2, $3, 'USDC', $4, $5, 'detected')
           ON CONFLICT (chain, signature) DO NOTHING`,
          [CHAIN, info.signature, deposit.amountMinor.toString(), opts.mint, deposit.slot],
        );
        if (inserted.rowCount === 0) return; // raced with another worker — no-op

        // Same key shape as the webhook route: watcher and webhook dedupe mutually.
        const recorded = await recordDeposit(client, {
          idempotencyKey: `${CHAIN}:${info.signature}`,
          externalAccountId: opts.externalAccountId,
          userAccountId: opts.userAccountId,
          amount: deposit.amountMinor,
          currency: 'USDC',
        });
        depositTransferId = recorded.transfer.id;
      });

      logger.info(
        `detected deposit ${info.signature} slot=${deposit.slot} amount=${deposit.amountMinor} USDC-minor (pending)`,
      );
      if (depositTransferId) {
        emitLedgerEvent(opts.events, {
          type: 'money.deposit.detected',
          transferId: depositTransferId,
          accountId: opts.userAccountId,
          amountMinor: deposit.amountMinor,
          currency: 'USDC',
          chain: CHAIN,
          txHash: info.signature,
        });
      }
    } catch (err) {
      // One bad signature must not poison the batch; it is retried next tick
      // because nothing was persisted for it.
      logger.warn(`detect failed for ${info.signature}: ${(err as Error).message}`);
    }
  }
}

// --- Phase 2: CONFIRM ----------------------------------------------------------

function isFinal(status: SignatureStatusView | null, threshold: number): boolean {
  if (!status || status.err) return false;
  if (status.confirmationStatus === 'finalized') return true;
  // Solana reports a ROOTED tx as confirmations=null — that is max finality.
  if (status.confirmations === null) return true;
  return status.confirmations >= threshold;
}

async function confirmDeposits(opts: ResolvedOptions): Promise<void> {
  const { rpc, logger } = opts;

  const detected = await pool.query<{ signature: string; amount_minor: string }>(
    `SELECT signature, amount_minor FROM chain_events
      WHERE chain = $1 AND status = 'detected'
      ORDER BY seen_at ASC
      LIMIT 100`,
    [CHAIN],
  );
  if (detected.rows.length === 0) return;

  const statuses = await rpc.getSignatureStatuses(detected.rows.map((r) => r.signature));

  for (const [i, row] of detected.rows.entries()) {
    const status = statuses[i] ?? null;
    if (!isFinal(status, opts.confirmations)) continue;

    try {
      const depositKey = `${CHAIN}:${row.signature}`;
      const dep = await pool.query<{ id: string }>(
        `SELECT id FROM transfers WHERE idempotency_key = $1`,
        [depositKey],
      );
      const depositTransferId = dep.rows[0]?.id;
      if (!depositTransferId) {
        logger.warn(`chain_event ${row.signature} has no matching deposit transfer — recon will flag it`);
        continue;
      }

      let event: OfframpConfirmedEvent | null = null;
      await withTx(async (client) => {
        // Guarded forward-only transition: rowcount 0 => another worker credited it.
        const advanced = await client.query(
          `UPDATE chain_events SET status = 'credited'
            WHERE chain = $1 AND signature = $2 AND status = 'detected'`,
          [CHAIN, row.signature],
        );
        if (advanced.rowCount === 0) return;

        const result = await confirmOfframpConverted(client, {
          idempotencyKey: `${depositKey}:offramp`,
          depositTransferId,
          userAccountId: opts.userAccountId,
          feeAccountId: opts.feeAccountId,
          conversionAccountId: opts.conversionAccountId,
          grossUsdcMinor: BigInt(row.amount_minor),
          feeBps: opts.feeBps,
        });

        event = {
          chain: CHAIN,
          signature: row.signature,
          depositTransferId,
          offrampTransferId: result.transfer.id,
          userAccountId: opts.userAccountId,
          quote: result.quote,
        };
      });

      if (event) {
        const e: OfframpConfirmedEvent = event;
        logger.info(
          `credited ${e.signature}: ${e.quote.grossUsdcMinor} USDC-minor -> net ${e.quote.netUsdCents} USD-cents (fee ${e.quote.feeUsdCents})`,
        );
        emitLedgerEvent(opts.events, {
          type: 'money.deposit.confirmed',
          transferId: e.depositTransferId,
          accountId: e.userAccountId,
          amountMinor: e.quote.grossUsdcMinor,
          currency: 'USDC',
          confirmations: opts.confirmations,
        });
        emitLedgerEvent(opts.events, {
          type: 'money.offramp.confirmed',
          transferId: e.offrampTransferId,
          depositTransferId: e.depositTransferId,
          accountId: e.userAccountId,
          amountMinor: e.quote.netUsdCents,
          feeMinor: e.quote.feeUsdCents,
          currency: 'USD',
        });
        if (onOfframpConfirmed) {
          // Post-commit, isolated: a routing failure must not mark the credit failed
          // (it is already durable) nor kill the watcher. Routing re-fires safely
          // thanks to its own UNIQUE(route_id, trigger_transfer_id) dedupe.
          try {
            await onOfframpConfirmed(e);
          } catch (err) {
            logger.error(`onOfframpConfirmed hook failed for ${e.signature}: ${(err as Error).message}`);
          }
        } else {
          logger.info(`no routing hook registered; confirmation for ${e.signature} logged only`);
        }
      }
    } catch (err) {
      logger.warn(`confirm failed for ${row.signature}: ${(err as Error).message}`);
    }
  }
}

// One full tick — exported so tests drive it deterministically without timers.
export async function pollOnce(options: WatcherOptions = {}): Promise<void> {
  const opts = resolve(options);
  await detectDeposits(opts);
  await confirmDeposits(opts);
}

export interface ChainWatcherHandle {
  stop(): void;
}

// Start the poller. setTimeout re-scheduling instead of setInterval so RPC
// failures can stretch the interval (exponential backoff, capped) — devnet
// rate-limits and flakes; the watcher degrades to slower polling, never crashes
// the process, and snaps back to WATCHER_POLL_MS on the first success.
export function startChainWatcher(options: WatcherOptions = {}): ChainWatcherHandle {
  const opts = resolve(options);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let consecutiveFailures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref?.(); // never keep the process alive just to poll
  };

  const run = async (): Promise<void> => {
    try {
      await pollOnce(options);
      consecutiveFailures = 0;
      schedule(opts.pollMs);
    } catch (err) {
      consecutiveFailures += 1;
      const backoff = Math.min(opts.pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
      opts.logger.error(
        `poll tick failed (attempt ${consecutiveFailures}): ${(err as Error).message}; retrying in ${backoff}ms`,
      );
      schedule(backoff);
    }
  };

  opts.logger.info(
    `watching ${opts.depositAta} (mint ${opts.mint}) on ${CHAIN} every ${opts.pollMs}ms, threshold=${opts.confirmations}`,
  );
  schedule(0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
