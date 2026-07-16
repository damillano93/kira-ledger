import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { ping } from './db.js';
import {
  docRouteOptions,
  healthzSchema,
  openapiDocument,
  readyzSchema,
} from './docs/openapi.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

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
