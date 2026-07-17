// The alerting policy, as code — the single source of truth for what pages.
//
// Every event type carries exactly one row here: its log level, whether it is
// paging-worthy (`page` -> emitted with `alert: true`), where it should land,
// the trigger condition an alerting pipeline would evaluate, and the first
// on-call action. OBSERVABILITY.md is the prose defense of this table; the
// table is what a log router (Datadog monitor, Loki ruler, Vector transform)
// would be generated from.
//
// Philosophy (scar tissue, not theory): a page at 3am must mean "money is at
// risk and a human decision is needed NOW". Everything that is merely broken —
// but bounded, retried, or reconciled — goes to Slack for the morning. Paging
// on symptoms of load (latency, CPU) wakes people for things that fix
// themselves; paging on money invariants wakes people for things that don't.

import type { LedgerEventType } from './events.js';

export type Severity = 'info' | 'warn' | 'error';

export interface AlertPolicy {
  /** pino level the event is emitted at. */
  level: Severity;
  /** true -> emitted with `alert: true`; routes to the paging pipeline. */
  page: boolean;
  /** Where a single occurrence (or the aggregate) should land. */
  channel: 'pagerduty' | 'slack' | 'log-only';
  /** The condition a monitor evaluates. Single events page on occurrence; rates page on threshold. */
  trigger: string;
  /** First move for whoever picks it up. */
  action: string;
}

export const ALERT_POLICY: Record<LedgerEventType, AlertPolicy> = {
  // -- money: normal operation (the baselines everything else is judged against)
  'money.deposit.detected': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'None on occurrence. Baseline for rate; absence-of-signal monitor: 0 detections in 30m during business hours -> Slack (watcher may be dead while /healthz is green).',
    action: 'If absence fires: check watcher cursor age and chain RPC health before assuming "quiet day".',
  },
  'money.deposit.confirmed': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'p95 latencyMs per chain > 3x its confirmation-time baseline for 15m -> Slack.',
    action: 'Distinguish chain congestion (external, wait) from watcher lag (ours, see watcher.confirmation_backlog).',
  },
  'money.offramp.confirmed': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'Rate divergence: confirmed deposits without matching offramp within SLA shows up as stuck_pending, not here.',
    action: 'None; this is the healthy tick of the inbound pipeline.',
  },
  'money.payout.initiated': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'Baseline for the settle/fail ratio monitors.',
    action: 'None.',
  },
  'money.payout.settled': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'p95 latencyMs per provider > provider SLA for 15m -> Slack.',
    action: 'Check provider status page; slow settlement becomes stuck_pending if it degrades further.',
  },
  'money.payout.failed': {
    level: 'error',
    page: true,
    channel: 'pagerduty',
    trigger: 'Any terminal failure (willRetry: false) -> page. Retryable: >5% of initiations failing over 10m, min 3 -> page; single retryable failure -> Slack.',
    action: 'getPayout(clientReference) against the provider FIRST (C3 window, DESIGN.md §8) — never blind-retry. If truly failed, verify the hold was released.',
  },
  'money.transfer.stuck_pending': {
    level: 'warn',
    page: true,
    channel: 'pagerduty',
    trigger: 'Emitted only past the rail SLA, so: any single transfer aged > 2x SLA, or aggregate stuck amount > $10k equivalent -> page. Below that -> Slack.',
    action: 'Check outbox state for the transfer (pending = dispatcher stalled; in_flight = recovery sweep should query provider). Aged transit balance is the same signal seen from the ledger.',
  },
  'money.route.fired': {
    level: 'info',
    page: false,
    channel: 'log-only',
    trigger: 'Baseline for the insufficient_funds ratio.',
    action: 'None.',
  },
  'money.route.insufficient_funds': {
    level: 'warn',
    page: false,
    channel: 'slack',
    trigger: 'Every occurrence -> Slack (visible, retryable state per ADR-013). >10x the account baseline in 15m, or many accounts at once -> page: either fraud probing balances or a double-reservation bug eating headroom.',
    action: 'Compare guard headroom vs SUM(entries) for the account. If they agree, funds are genuinely short (business). If they drift, it is our bug — recon.balance_drift territory.',
  },

  // -- recon: the backstop speaking. Recon findings are never noise.
  'recon.mismatch.settled_no_entry': {
    level: 'error',
    page: true,
    channel: 'pagerduty',
    trigger: 'Any occurrence -> page. The world moved money we did not record; client balances are wrong RIGHT NOW.',
    action: 'Identify the ingestion gap (missed webhook? watcher gap? C3 far side?) and post the compensating entry via suspense — recon reports, never edits (§9).',
  },
  'recon.mismatch.entry_never_confirmed': {
    level: 'error',
    page: true,
    channel: 'pagerduty',
    trigger: 'Payout-side occurrence -> page (we may owe money that never moved, or moved unrecorded). Deposit-side single item aged < 2x SLA -> Slack.',
    action: 'getPayout / re-scan the chain for the external fact. A late statement row clears it through the normal event path; only page-worthy if the provider genuinely has no record.',
  },
  'recon.balance_drift': {
    level: 'error',
    page: true,
    channel: 'pagerduty',
    trigger: 'Any occurrence, any amount, any hour -> page. guard != SUM(entries) means the no-negative invariant is standing on a lie.',
    action: 'Freeze spends for the account (guard is rebuildable from entries — ADR-020), rebuild, then find which code path moved one side without the other.',
  },

  // -- edges
  'watcher.confirmation_backlog': {
    level: 'warn',
    page: true,
    channel: 'pagerduty',
    trigger: 'Emitted when depth/age crosses the watcher threshold. oldestAgeSeconds > 1800 -> page (deposits invisible to customers = support fire + missed route triggers). Depth rising but young -> Slack.',
    action: 'Check RPC provider first (most common), then watcher loop liveness. Cursor is persisted; restart re-scans with overlap, idempotency absorbs the replay.',
  },
  'provider.webhook.rejected': {
    level: 'warn',
    page: false,
    channel: 'slack',
    trigger: 'bad_signature > 5/min for 5m -> page: either OUR secret rotation broke (all confirmations now dark -> stuck_pending cascade) or someone is forging callbacks. stale_timestamp spike -> Slack (clock skew or replay probing). duplicate -> log-only, that is idempotency working.',
    action: 'One test webhook with the current secret decides it: verification broken = rotate/rollback secret; verification fine = attack, capture source and block.',
  },
  'provider.call.failed': {
    level: 'warn',
    page: false,
    channel: 'slack',
    trigger: '100% failure to one provider for 5m -> page (payout pipeline is down even though our HTTP surface is green; outbox absorbs the backlog but funds sit held). Sporadic with willRetry: true -> log-only.',
    action: 'Provider status page, then outbox depth. Backpressure (bounded batches + next_retry_at) keeps the dispatcher from stampeding — verify it is holding (ADR-020).',
  },
};
