import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { docRouteOptions } from '../docs/openapi.js';
import {
  mockPollSchema,
  mockSettleSchema,
  mockStatementsSchema,
  routingExecutionGetSchema,
  routingRetrySchema,
  routingTriggerSchema,
} from '../docs/routing-schemas.js';
import { requireApiKey } from '../middleware/auth.js';
import { emitLedgerEvent } from '../observability/events.js';
import {
  dispatchExecution,
  onOfframpConfirmed,
  retryExecution,
  RouteTriggerError,
  type RouteLegRow,
  type TriggeredExecution,
} from '../routing/engine.js';
import { applyProviderEvent } from '../routing/settlement.js';
import { hasMockControls, UnknownPayoutError } from '../vendors/provider.js';
import { defaultRegistry, type ProviderRegistry } from '../vendors/registry.js';

// HTTP surface of the routing engine + the mock provider settlement levers.
// NOT wired into server.ts here — the integration wave registers these:
//   await registerRoutingRoutes(app);
//   await registerMockProviderRoutes(app);
// Both default to the process-wide provider registry so the dispatcher and the
// settlement endpoints share the mocks' in-memory payout state.

export interface RoutingRouteOptions {
  registry?: ProviderRegistry;
}

// -- serialisation helpers (amounts as strings, camelCase out) -----------------

function serialiseLeg(row: RouteLegRow) {
  return {
    legId: row.id,
    seq: row.seq,
    provider: row.provider,
    status: row.status,
    externalRef: row.external_ref,
    transferId: row.transfer_id,
    amount: row.amount_minor, // pg BIGINT arrives as a string; kept as one
    currency: row.currency,
    sourceAmount: row.source_amount_minor,
    sourceCurrency: row.source_currency,
    failureReason: row.failure_reason,
  };
}

async function loadLegs(executionId: string): Promise<RouteLegRow[]> {
  const res = await pool.query<RouteLegRow>(
    `SELECT * FROM route_legs WHERE execution_id = $1 ORDER BY seq`,
    [executionId],
  );
  return res.rows;
}

// -- routing endpoints ----------------------------------------------------------

const triggerBodySchema = z.object({
  offrampTransferId: z.string().uuid(),
  userAccountId: z.string().uuid(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export async function registerRoutingRoutes(
  app: FastifyInstance,
  options: RoutingRouteOptions = {},
): Promise<void> {
  const registry = options.registry ?? defaultRegistry;

  // Fire the routes watching an account for a confirmed off-ramp. Reservation
  // commits first (one DB transaction, all-or-nothing); providers are called
  // only AFTER commit — never provider I/O inside a DB transaction.
  app.post(
    '/routing/trigger',
    { preHandler: requireApiKey, schema: routingTriggerSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = triggerBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid payload', details: parsed.error.issues });
      }
      const body = parsed.data;

      let triggered: TriggeredExecution[];
      try {
        triggered = await withTx((client) =>
          onOfframpConfirmed(client, body.offrampTransferId, body.userAccountId, request.log),
        );
      } catch (err) {
        if (err instanceof RouteTriggerError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      const executions = [];
      for (const execution of triggered) {
        if (execution.status === 'reserved') {
          await dispatchExecution(execution.executionId, registry, request.log);
        }
        executions.push({
          ...execution,
          legs: (await loadLegs(execution.executionId)).map(serialiseLeg),
        });
      }

      return reply.send({ executions });
    },
  );

  // Retry a visible/retryable insufficient_funds execution.
  app.post(
    '/routing/executions/:id/retry',
    { preHandler: requireApiKey, schema: routingRetrySchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = idParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid execution id' });
      }
      const executionId = parsed.data.id;

      const result = await withTx((client) => retryExecution(client, executionId, request.log));
      if (result === null) {
        // Guarded transition lost: the execution is not insufficient_funds.
        return reply.code(409).send({ error: 'execution is not retryable' });
      }

      if (result.status === 'insufficient_funds') {
        return reply
          .code(422)
          .send({ error: 'insufficient funds', executionId, status: result.status });
      }

      await dispatchExecution(executionId, registry, request.log);
      return reply.send({
        executionId,
        status: result.status,
        legs: (await loadLegs(executionId)).map(serialiseLeg),
      });
    },
  );

  // Audit view: the execution with every leg's own lifecycle state.
  app.get(
    '/routing/executions/:id',
    { schema: routingExecutionGetSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = idParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid execution id' });
      }

      const res = await pool.query<{
        id: string;
        route_id: string;
        trigger_transfer_id: string;
        status: string;
      }>(
        `SELECT id, route_id, trigger_transfer_id, status FROM route_executions WHERE id = $1`,
        [parsed.data.id],
      );
      const execution = res.rows[0];
      if (!execution) {
        return reply.code(404).send({ error: 'execution not found' });
      }

      return reply.send({
        executionId: execution.id,
        routeId: execution.route_id,
        triggerTransferId: execution.trigger_transfer_id,
        status: execution.status,
        legs: (await loadLegs(execution.id)).map(serialiseLeg),
      });
    },
  );
}

// -- mock provider endpoints ------------------------------------------------------

const providerParamsSchema = z.object({ provider: z.string().min(1) });

const settleBodySchema = z.object({
  externalRef: z.string().min(1),
  outcome: z.enum(['settled', 'failed']).default('settled'),
  failureReason: z.string().optional(),
});

const pollBodySchema = z.object({ externalRef: z.string().min(1) });

// Mock-only surface standing in for the providers' own settlement channels
// (AcmePay's webhooks, LegacyBank's poll API, Polygon finality). Real provider
// webhooks would arrive HMAC-signed on their own verified receivers (ADR-021);
// these mock levers exist so demos/tests can drive settlement deterministically
// and are deliberately unauthenticated under the /mock prefix.
export async function registerMockProviderRoutes(
  app: FastifyInstance,
  options: RoutingRouteOptions = {},
): Promise<void> {
  const registry = options.registry ?? defaultRegistry;

  // Force a settlement (or failure): emits the provider's NATIVE payload and
  // feeds it through the adapter — the same path a real webhook would take.
  app.post(
    '/mock/providers/:provider/settle',
    { schema: mockSettleSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = providerParamsSchema.safeParse(request.params);
      const body = settleBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid payload' });
      }

      const provider = registry.maybeGet(params.data.provider);
      if (!provider || !hasMockControls(provider)) {
        return reply.code(404).send({ error: 'unknown provider' });
      }

      try {
        const nativeEvent = provider.emitSettlementEvent(
          body.data.externalRef,
          body.data.outcome,
          body.data.failureReason,
        );
        const canonicalEvent = provider.handleProviderEvent(nativeEvent);
        const result = await applyProviderEvent(provider.name, canonicalEvent, request.log);
        return reply.send({ provider: provider.name, nativeEvent, canonicalEvent, result });
      } catch (err) {
        if (err instanceof UnknownPayoutError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Poll path: ask the provider, apply if terminal. Safe to call repeatedly.
  app.post(
    '/mock/providers/:provider/poll',
    { schema: mockPollSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = providerParamsSchema.safeParse(request.params);
      const body = pollBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid payload' });
      }

      const provider = registry.maybeGet(params.data.provider);
      if (!provider) {
        return reply.code(404).send({ error: 'unknown provider' });
      }

      try {
        const canonicalEvent = await provider.getPayout(body.data.externalRef);
        const result =
          canonicalEvent.status === 'settled' || canonicalEvent.status === 'failed'
            ? await applyProviderEvent(provider.name, canonicalEvent, request.log)
            : null;
        return reply.send({ provider: provider.name, canonicalEvent, result });
      } catch (err) {
        if (err instanceof UnknownPayoutError) {
          emitLedgerEvent(request.log, {
            type: 'provider.call.failed',
            provider: provider.name,
            operation: 'getPayout',
            reason: err.message,
          });
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Provider-side truth of settled payouts — recon input.
  app.get(
    '/mock/providers/:provider/statements',
    { schema: mockStatementsSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = providerParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid provider' });
      }
      const provider = registry.maybeGet(params.data.provider);
      if (!provider) {
        return reply.code(404).send({ error: 'unknown provider' });
      }
      return reply.send({
        provider: provider.name,
        rows: provider.exportStatementRows().map((row) => ({
          externalRef: row.externalRef,
          amount: row.amountMinor.toString(), // bigint -> string on the wire
          currency: row.currency,
          settledAt: row.settledAt,
        })),
      });
    },
  );
}
