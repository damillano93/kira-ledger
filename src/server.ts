import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { setOnOfframpConfirmed, startChainWatcher } from './chain/index.js';
import { config } from './config.js';
import { ping, withTx } from './db.js';
import {
  docRouteOptions,
  healthzSchema,
  openapiDocument,
  readyzSchema,
} from './docs/openapi.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerReconRoutes } from './routes/recon.js';
import { registerRoutingRoutes, registerMockProviderRoutes } from './routes/routing.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { dispatchExecution, onOfframpConfirmed } from './routing/engine.js';
import { defaultRegistry } from './vendors/registry.js';

export async function buildServer() {
  const app = Fastify({ logger: true });

  // OpenAPI docs. Registered BEFORE the routes so every route's documentary
  // `schema` is collected into the spec. Swagger UI is served at /docs and the
  // raw OpenAPI JSON at /docs/json. The attached schemas are documentation-only
  // (see docs/openapi.ts): validation and serialization behaviour are unchanged.
  await app.register(fastifySwagger, { openapi: openapiDocument });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // Capture the raw request body so webhook HMAC verification runs over the exact
  // bytes that were signed (a re-serialisation of the parsed JSON would differ).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (_req as FastifyRequest & { rawBody?: string }).rawBody = raw;
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Liveness: process is up.
  app.get(
    '/healthz',
    { schema: healthzSchema, ...docRouteOptions },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ status: 'ok' });
    },
  );

  // Readiness: dependencies (the database) are reachable.
  app.get(
    '/readyz',
    { schema: readyzSchema, ...docRouteOptions },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        await ping();
        return reply.send({ status: 'ready' });
      } catch {
        return reply.code(503).send({ status: 'not-ready' });
      }
    },
  );

  await registerWebhookRoutes(app);
  await registerTransferRoutes(app);
  await registerAccountRoutes(app);
  await registerDashboardRoutes(app);
  await registerRoutingRoutes(app);
  await registerMockProviderRoutes(app);
  await registerReconRoutes(app);

  // Chain watcher wiring — only when explicitly enabled (default false: an env
  // without Solana config must boot exactly as before).
  //
  // Contract bridge, watcher -> routing: the watcher fires its hook AFTER the
  // credit transaction commits (a routing failure must never roll back a
  // durable credit), while the engine's onOfframpConfirmed reserves inside a
  // caller-provided transaction. So the bridge opens a NEW transaction for the
  // reservation (all-or-nothing, same as POST /routing/trigger) and dispatches
  // providers only AFTER that commit — never provider I/O inside a DB
  // transaction. A redelivered confirmation is absorbed by the engine's
  // UNIQUE(route_id, trigger_transfer_id) guardrail (R4), so at-least-once
  // delivery here is safe.
  if (config.ENABLE_CHAIN_WATCHER) {
    setOnOfframpConfirmed(async (event) => {
      const triggered = await withTx((client) =>
        onOfframpConfirmed(client, event.offrampTransferId, event.userAccountId, app.log),
      );
      for (const execution of triggered) {
        if (execution.status === 'reserved') {
          await dispatchExecution(execution.executionId, defaultRegistry, app.log);
        }
      }
    });
    const watcher = startChainWatcher({ logger: app.log, events: app.log });
    app.addHook('onClose', async () => {
      watcher.stop();
      setOnOfframpConfirmed(null);
    });
  }

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
