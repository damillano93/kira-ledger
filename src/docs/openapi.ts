import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifySchema } from 'fastify';
import type { OpenAPIV3 } from 'openapi-types';
// Importing the plugin's types applies its module augmentation to `FastifySchema`
// (adding `tags`, `summary`, `description`, `security`, ...) across the program.
import '@fastify/swagger';

// Read the version straight from package.json (cwd is the repo root in dev, in
// vitest, and in the Docker runtime image), so the spec version tracks the app.
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as { version: string };

export const API_VERSION: string = pkg.version;

// --- OpenAPI document metadata (info, tags, security schemes) ---------------
// Passed to @fastify/swagger. Per-route `schema` blocks below are merged in by
// the plugin to produce the full document served at /docs and /docs/json.
export const openapiDocument: Partial<OpenAPIV3.Document> = {
  openapi: '3.0.3',
  info: {
    title: 'Kira Ledger API',
    version: API_VERSION,
    description:
      'Multi-rail ledger and payment-orchestration engine. Double-entry, ' +
      'idempotent, and race-safe.\n\n' +
      '**Money is always integer minor units transmitted as a string** ' +
      '(e.g. `"1050"` = 10.50 USD) — never a float, so no precision is ever ' +
      'lost. Balances are returned the same way.',
  },
  tags: [
    { name: 'transfers', description: 'Outbound payouts (authenticated, idempotent).' },
    { name: 'webhooks', description: 'Inbound signed chain webhooks (HMAC-verified).' },
    { name: 'accounts', description: 'Account balance queries.' },
    { name: 'system', description: 'Liveness and readiness probes.' },
  ],
  components: {
    securitySchemes: {
      // Static API key presented as `Authorization: Bearer <key>`.
      bearerApiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Static API key presented as `Authorization: Bearer <key>`. ' +
          '(The `x-api-key: <key>` header is also accepted.)',
      },
    },
  },
};

// --- Runtime-neutral schema compilers ---------------------------------------
// The route `schema` blocks exist SOLELY to generate documentation. Validation
// stays 100% manual (zod inside each handler) and error/response shapes are
// asserted by the test-suite, so we must never let Fastify validate a request
// or reshape a reply. These no-op compilers make every attached schema purely
// documentary: bodies/params pass through untouched, replies serialise verbatim.
export const noopValidatorCompiler = () => () => true;
export const noopSerializerCompiler = () => (data: unknown): string => JSON.stringify(data);

// Options bundle applied to every documented route so it behaves identically
// whether registered through buildServer() or a bare Fastify instance (as the
// unit tests do). Spread alongside `schema` in the route options.
export const docRouteOptions = {
  validatorCompiler: noopValidatorCompiler,
  serializerCompiler: noopSerializerCompiler,
};

// --- Reusable schema fragments ----------------------------------------------
const amountSchema = {
  type: 'string',
  pattern: '^\\d+$',
  description:
    'Integer minor units as a string (e.g. cents). Never a float — a decimal, ' +
    'sign, whitespace, or scientific notation is rejected with 400. `"1050"` = 10.50 USD.',
  example: '1050',
};

const transferResultSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string', format: 'uuid', description: 'The ledger transfer id.' },
    status: { type: 'string', example: 'posted', description: 'Transfer status.' },
    idempotent: {
      type: 'boolean',
      description: 'true when this call replayed an existing transfer (200), false when it created one (201).',
    },
  },
  required: ['transferId', 'status', 'idempotent'],
};

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' }, description: 'Present on validation failures (zod issues).' },
  },
  required: ['error'],
};

// --- Per-route schemas ------------------------------------------------------

export const payoutSchema: FastifySchema = {
  tags: ['transfers'],
  summary: 'Create an outbound payout',
  description:
    'Debits a user account and credits a destination account in a single ' +
    'double-entry transfer. **Idempotent** via the `idempotency-key` header: ' +
    'replaying the same key returns the original transfer (200) instead of ' +
    'creating a new one (201). Requires a valid API key.',
  security: [{ bearerApiKey: [] }],
  headers: {
    type: 'object',
    properties: {
      'idempotency-key': {
        type: 'string',
        description: 'Required. Unique client-supplied key that de-duplicates retries.',
        example: 'payout-2026-07-16-abc123',
      },
    },
    required: ['idempotency-key'],
  },
  body: {
    type: 'object',
    required: ['userAccountId', 'destinationAccountId', 'amount', 'currency'],
    properties: {
      userAccountId: { type: 'string', format: 'uuid', description: 'Account to debit.' },
      destinationAccountId: { type: 'string', format: 'uuid', description: 'Account to credit.' },
      amount: amountSchema,
      currency: { type: 'string', minLength: 1, example: 'USD' },
    },
  },
  response: {
    201: { description: 'Payout created.', ...transferResultSchema },
    200: { description: 'Idempotent replay of an existing payout.', ...transferResultSchema },
    400: {
      description: 'Missing `idempotency-key` header, or an invalid payload (e.g. a float amount).',
      ...errorSchema,
      example: { error: 'invalid payload', details: [] },
    },
    401: {
      description: 'Missing or invalid API key.',
      ...errorSchema,
      example: { error: 'unauthorized' },
    },
    422: {
      description: 'The source account has insufficient available funds.',
      type: 'object',
      properties: { error: { type: 'string' }, accountId: { type: 'string', format: 'uuid' } },
      required: ['error', 'accountId'],
      example: { error: 'insufficient funds', accountId: '00000000-0000-0000-0000-000000000000' },
    },
  },
};

export const webhookSchema: FastifySchema = {
  tags: ['webhooks'],
  summary: 'Ingest a signed chain deposit webhook',
  description:
    'Books a detected on-chain deposit into the ledger (credited to PENDING).\n\n' +
    '**Signature scheme:** the request must carry `x-signature` = ' +
    '`HMAC-SHA256(WEBHOOK_SECRET, rawBody)` (hex) computed over the exact raw ' +
    'request body, and `x-timestamp` (unix seconds) within a 300s freshness ' +
    'window for replay protection. **Idempotency:** `chain:txHash` is the key, ' +
    'so a redelivered webhook is a no-op that returns the original transfer.',
  headers: {
    type: 'object',
    properties: {
      'x-signature': {
        type: 'string',
        description: 'Hex HMAC-SHA256 of the raw body keyed with WEBHOOK_SECRET.',
      },
      'x-timestamp': {
        type: 'string',
        description: 'Unix seconds; must be within 300s of server time.',
        example: '1752624000',
      },
    },
    required: ['x-signature', 'x-timestamp'],
  },
  body: {
    type: 'object',
    required: ['txHash', 'chain', 'amount', 'currency', 'userAccountId', 'externalAccountId'],
    properties: {
      txHash: { type: 'string', minLength: 1, description: 'On-chain transaction hash (idempotency key).' },
      chain: { type: 'string', minLength: 1, example: 'ethereum' },
      amount: amountSchema,
      currency: { type: 'string', minLength: 1, example: 'USD' },
      userAccountId: { type: 'string', format: 'uuid' },
      externalAccountId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    201: { description: 'Deposit booked.', ...transferResultSchema },
    200: { description: 'Idempotent replay of an already-booked deposit.', ...transferResultSchema },
    400: { description: 'Invalid payload.', ...errorSchema, example: { error: 'invalid payload', details: [] } },
    401: {
      description: 'Stale/missing timestamp or an invalid signature.',
      ...errorSchema,
      example: { error: 'invalid signature' },
    },
  },
};

export const balanceSchema: FastifySchema = {
  tags: ['accounts'],
  summary: 'Get an account balance',
  description:
    'Returns the available and pending balances for an account. Amounts are ' +
    'integer minor units serialised as strings.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'Account id.' } },
    required: ['id'],
  },
  response: {
    200: {
      description: 'The account balance.',
      type: 'object',
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        available: { type: 'string', description: 'Spendable minor units.', example: '10000' },
        pending: { type: 'string', description: 'Reserved / unconfirmed minor units.', example: '0' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
      required: ['accountId', 'available', 'pending', 'updatedAt'],
    },
    400: { description: 'The id is not a valid UUID.', ...errorSchema, example: { error: 'invalid account id' } },
    404: { description: 'No such account.', ...errorSchema, example: { error: 'account not found' } },
  },
};

export const healthzSchema: FastifySchema = {
  tags: ['system'],
  summary: 'Liveness probe',
  description: 'Returns 200 while the process is up.',
  response: {
    200: {
      description: 'Process is alive.',
      type: 'object',
      properties: { status: { type: 'string', example: 'ok' } },
      required: ['status'],
    },
  },
};

export const readyzSchema: FastifySchema = {
  tags: ['system'],
  summary: 'Readiness probe',
  description: 'Returns 200 when the database is reachable, 503 otherwise.',
  response: {
    200: {
      description: 'Dependencies are reachable.',
      type: 'object',
      properties: { status: { type: 'string', example: 'ready' } },
      required: ['status'],
    },
    503: {
      description: 'A dependency (the database) is unreachable.',
      type: 'object',
      properties: { status: { type: 'string', example: 'not-ready' } },
      required: ['status'],
    },
  },
};
