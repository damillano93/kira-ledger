import type { FastifySchema } from 'fastify';
// Module augmentation for FastifySchema (tags, summary, ...) — see openapi.ts.
import '@fastify/swagger';

// Documentation-only schemas for the routing + mock-provider endpoints,
// following the pattern of src/docs/openapi.ts: schemas document, zod inside
// each handler validates. Attach together with `docRouteOptions`.

const amountSchema = {
  type: 'string',
  pattern: '^\\d+$',
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

const legSchema = {
  type: 'object',
  properties: {
    legId: { type: 'string', format: 'uuid' },
    seq: { type: 'integer', description: 'Declared execution order within the route.' },
    provider: { type: 'string', example: 'acmepay', description: 'Provider registry key.' },
    status: {
      type: 'string',
      enum: ['reserved', 'initiated', 'settled', 'failed'],
      description: 'Leg lifecycle: reserved -> initiated -> settled | failed (monotonic).',
    },
    externalRef: {
      type: 'string',
      nullable: true,
      description: "The provider's reference (payout id / payment ref / tx hash) once dispatched.",
    },
    transferId: { type: 'string', format: 'uuid', description: 'The ledger reservation transfer.' },
    amount: amountSchema,
    currency: { type: 'string', example: 'USD' },
    sourceAmount: {
      ...amountSchema,
      description: 'Minor units debited from the user account (source currency).',
    },
    sourceCurrency: { type: 'string', example: 'USD' },
    failureReason: { type: 'string', nullable: true },
  },
  required: ['legId', 'seq', 'provider', 'status', 'amount', 'currency'],
};

const executionSchema = {
  type: 'object',
  properties: {
    executionId: { type: 'string', format: 'uuid' },
    routeId: { type: 'string', format: 'uuid' },
    triggerTransferId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['reserving', 'reserved', 'insufficient_funds', 'completed', 'failed'],
      description:
        '`insufficient_funds` is a visible, RETRYABLE state: nothing was ' +
        'reserved (no partial fills) and POST .../retry re-evaluates it.',
    },
    legs: { type: 'array', items: legSchema },
  },
  required: ['executionId', 'routeId', 'status'],
};

export const routingTriggerSchema: FastifySchema = {
  tags: ['routing'],
  summary: 'Fire the routes watching an account (off-ramp confirmed)',
  description:
    'Evaluates every active route whose trigger account just received a ' +
    'confirmed off-ramp, fires each **at most once per trigger transfer** ' +
    '(`UNIQUE(route_id, trigger_transfer_id)` — a redelivery is a no-op that ' +
    'returns the existing execution), reserves funds for ALL actions in one ' +
    'transaction in `seq` order, then dispatches the reserved legs to their ' +
    'providers after commit. If the total exceeds net available, the execution ' +
    'parks in `insufficient_funds` — visible and retryable, never partial.\n\n' +
    'This is the same entry point the chain watcher calls in-process; the ' +
    'endpoint exposes it for ops/demo use.',
  security: [{ bearerApiKey: [] }],
  body: {
    type: 'object',
    required: ['offrampTransferId', 'userAccountId'],
    properties: {
      offrampTransferId: {
        type: 'string',
        format: 'uuid',
        description: 'The confirmed off-ramp transfer acting as the trigger.',
      },
      userAccountId: {
        type: 'string',
        format: 'uuid',
        description: 'The account whose routes should be evaluated.',
      },
    },
  },
  response: {
    200: {
      description: 'Route evaluation results (one element per matched route).',
      type: 'object',
      properties: {
        executions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              routeId: { type: 'string', format: 'uuid' },
              executionId: { type: 'string', format: 'uuid' },
              status: {
                type: 'string',
                enum: ['reserved', 'insufficient_funds', 'already_fired'],
              },
              legs: { type: 'array', items: legSchema },
            },
            required: ['routeId', 'executionId', 'status'],
          },
        },
      },
      required: ['executions'],
    },
    400: { description: 'Invalid payload.', ...errorSchema },
    401: { description: 'Missing or invalid API key.', ...errorSchema },
    409: {
      description: 'The trigger transfer is not a confirmed off-ramp.',
      ...errorSchema,
      example: { error: 'trigger transfer is not a confirmed off-ramp' },
    },
  },
};

export const routingRetrySchema: FastifySchema = {
  tags: ['routing'],
  summary: 'Retry an insufficient_funds route execution',
  description:
    'Re-evaluates a stalled execution against the current available balance. ' +
    'Guarded transition: only `insufficient_funds` executions are retryable — ' +
    'anything else answers 409 and nothing moves. On success the legs are ' +
    'reserved (all-or-nothing) and dispatched.',
  security: [{ bearerApiKey: [] }],
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  response: {
    200: {
      description: 'Reservation succeeded; legs dispatched.',
      type: 'object',
      properties: {
        executionId: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'reserved' },
        legs: { type: 'array', items: legSchema },
      },
      required: ['executionId', 'status'],
    },
    401: { description: 'Missing or invalid API key.', ...errorSchema },
    409: {
      description: 'The execution is not in a retryable state.',
      ...errorSchema,
      example: { error: 'execution is not retryable' },
    },
    422: {
      description: 'Still insufficient funds; the execution remains retryable.',
      type: 'object',
      properties: {
        error: { type: 'string', example: 'insufficient funds' },
        executionId: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'insufficient_funds' },
      },
      required: ['error', 'executionId', 'status'],
    },
  },
};

export const routingExecutionGetSchema: FastifySchema = {
  tags: ['routing'],
  summary: 'Inspect a route execution and its legs',
  description:
    'The audit view: execution status plus every outbound leg with its own ' +
    'lifecycle state, provider reference and ledger transfer. Amounts are ' +
    'integer minor units as strings.',
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  response: {
    200: { description: 'The execution.', ...executionSchema },
    400: { description: 'Invalid execution id.', ...errorSchema },
    404: { description: 'No such execution.', ...errorSchema },
  },
};

export const mockSettleSchema: FastifySchema = {
  tags: ['mock-providers'],
  summary: 'Force a mock provider to settle (or fail) a payout',
  description:
    'Drives the named MOCK provider to emit its **native** settlement payload ' +
    '(AcmePay: camelCase webhook with integer-cents-as-number; LegacyBank: ' +
    'snake_case poll body with decimal-dollar strings; polygon-usdt: a chain ' +
    'finality event), then feeds that payload through the adapter into the ' +
    'canonical pipeline — so forcing settlement exercises the exact mapping a ' +
    'real webhook/poll would. Settling marks the leg settled, confirms its ' +
    'ledger transfer and books a `provider_statements` row (recon input); ' +
    'failing releases the reservation with compensating entries. Idempotent: ' +
    'a duplicate settle is a keyed no-op.',
  params: {
    type: 'object',
    properties: {
      provider: { type: 'string', example: 'acmepay', description: 'Provider registry key.' },
    },
    required: ['provider'],
  },
  body: {
    type: 'object',
    required: ['externalRef'],
    properties: {
      externalRef: {
        type: 'string',
        description: "The provider's reference returned at dispatch (see the execution view).",
      },
      outcome: {
        type: 'string',
        enum: ['settled', 'failed'],
        default: 'settled',
      },
      failureReason: { type: 'string', description: 'Optional, only for outcome=failed.' },
    },
  },
  response: {
    200: {
      description: 'The native payload emitted, its canonical mapping, and the applied result.',
      type: 'object',
      properties: {
        provider: { type: 'string' },
        nativeEvent: { type: 'object', description: "The provider's own wire shape." },
        canonicalEvent: { type: 'object', description: 'The one shape downstream consumes.' },
        result: { type: 'object' },
      },
      required: ['provider', 'nativeEvent', 'canonicalEvent', 'result'],
    },
    400: { description: 'Invalid payload.', ...errorSchema },
    404: {
      description: 'Unknown provider, or the provider knows no such payout.',
      ...errorSchema,
    },
  },
};

export const mockPollSchema: FastifySchema = {
  tags: ['mock-providers'],
  summary: 'Poll a mock provider for a payout and apply the result',
  description:
    'The polling strategy (LegacyBank-style, and how the simulated polygon ' +
    'send settles after its delay): asks the provider for the current state, ' +
    'synthesizes the canonical event and — when terminal — applies it exactly ' +
    'as a webhook would be. Safe to call repeatedly.',
  params: {
    type: 'object',
    properties: { provider: { type: 'string', example: 'polygon-usdt' } },
    required: ['provider'],
  },
  body: {
    type: 'object',
    required: ['externalRef'],
    properties: { externalRef: { type: 'string' } },
  },
  response: {
    200: {
      description: 'Current canonical state (and the applied result if terminal).',
      type: 'object',
      properties: {
        provider: { type: 'string' },
        canonicalEvent: { type: 'object' },
        result: { type: 'object', nullable: true },
      },
      required: ['provider', 'canonicalEvent'],
    },
    400: { description: 'Invalid payload.', ...errorSchema },
    404: { description: 'Unknown provider or payout.', ...errorSchema },
  },
};

export const mockStatementsSchema: FastifySchema = {
  tags: ['mock-providers'],
  summary: "Export a mock provider's settled-payout statement",
  description:
    'Provider-side truth for reconciliation: the rows the provider itself ' +
    'claims settled. The recon job compares these against the ledger in both ' +
    'directions (DESIGN §9). Amounts are integer minor units as strings.',
  params: {
    type: 'object',
    properties: { provider: { type: 'string', example: 'legacybank' } },
    required: ['provider'],
  },
  response: {
    200: {
      description: 'Statement rows.',
      type: 'object',
      properties: {
        provider: { type: 'string' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              externalRef: { type: 'string' },
              amount: amountSchema,
              currency: { type: 'string' },
              settledAt: { type: 'string', format: 'date-time' },
            },
            required: ['externalRef', 'amount', 'currency', 'settledAt'],
          },
        },
      },
      required: ['provider', 'rows'],
    },
    404: { description: 'Unknown provider.', ...errorSchema },
  },
};
