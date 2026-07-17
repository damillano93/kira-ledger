import type { FastifySchema } from 'fastify';
// Module augmentation for FastifySchema (tags, summary, ...) — see openapi.ts.
import '@fastify/swagger';

// Documentation-only schema for the reconciliation report endpoint, following
// the pattern of src/docs/openapi.ts: schemas document, zod inside the handler
// validates. Attach together with `docRouteOptions`.

const amountSchema = {
  type: 'string',
  nullable: true,
  pattern: '^-?\\d+$',
  description: 'Integer minor units as a string. Never a float.',
  example: '420000',
};

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' } },
  },
  required: ['error'],
};

const mismatchSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['settled_no_entry', 'entry_never_confirmed', 'balance_drift'],
      description:
        '`settled_no_entry`: the world moved money the ledger never recorded. ' +
        '`entry_never_confirmed`: the ledger recorded intent the world never confirmed (past SLA). ' +
        '`balance_drift`: a spend_guard row disagrees with SUM(entries) — the guard is no longer rebuildable.',
    },
    side: {
      type: 'string',
      description:
        'Which system holds the unmatched fact: `chain:<chain>`, `provider:<name>`, ' +
        '`ledger:transfer`, `ledger:route_leg`, `ledger:spend_guard`.',
      example: 'chain:solana-devnet',
    },
    ref: {
      type: 'string',
      description: 'The identifying reference: tx signature, provider external_ref, transfer/leg id, account id.',
    },
    amountMinor: { ...amountSchema, description: 'The unmatched amount (for balance_drift: the drift itself).' },
    currency: { type: 'string', nullable: true, example: 'USD' },
    ageMinutes: {
      type: 'integer',
      nullable: true,
      description: 'Age of the unmatched fact/intent in whole minutes; null for point-in-time checks.',
    },
    detail: { type: 'string', description: 'Human-readable one-liner for the ops runbook.' },
  },
  required: ['type', 'side', 'ref', 'detail'],
};

export const reconReportSchema: FastifySchema = {
  tags: ['recon'],
  summary: 'Run end-of-day reconciliation and return the report',
  description:
    'Runs the reconciliation job (DESIGN §9) as pure anti-join queries over the ' +
    'append-only ledger and returns the structured report. Catches both mismatch ' +
    'directions — **settled-with-no-entry** (chain events / provider statements ' +
    'with no ledger transfer) and **entry-never-confirmed** (pending transfers / ' +
    'open route legs past SLA with no external fact) — plus **balance drift** ' +
    '(spend_guards vs SUM(entries)). Read-only: reconciliation reports, it never ' +
    'edits; corrections are future compensating entries. Requires a valid API key.',
  security: [{ bearerApiKey: [] }],
  querystring: {
    type: 'object',
    properties: {
      maxAgeMinutes: {
        type: 'integer',
        minimum: 1,
        default: 60,
        description:
          'SLA threshold for entry-never-confirmed: only ledger intents older than this are flagged.',
      },
    },
  },
  response: {
    200: {
      description: 'The reconciliation report. `ok: true` means zero mismatches.',
      type: 'object',
      properties: {
        runAt: { type: 'string', format: 'date-time' },
        ok: { type: 'boolean' },
        maxAgeMinutes: { type: 'integer' },
        checked: {
          type: 'object',
          description: 'Coverage counters, so an empty report is distinguishable from an empty database.',
          properties: {
            chainStatements: { type: 'integer' },
            providerStatements: { type: 'integer' },
            pendingTransfers: { type: 'integer' },
            openLegs: { type: 'integer' },
            guardedAccounts: { type: 'integer' },
          },
        },
        mismatches: { type: 'array', items: mismatchSchema },
      },
      required: ['runAt', 'ok', 'maxAgeMinutes', 'checked', 'mismatches'],
    },
    400: { description: 'Invalid query parameters.', ...errorSchema, example: { error: 'invalid query' } },
    401: { description: 'Missing or invalid API key.', ...errorSchema, example: { error: 'unauthorized' } },
  },
};
