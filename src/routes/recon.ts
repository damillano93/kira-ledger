import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { docRouteOptions } from '../docs/openapi.js';
import { reconReportSchema } from '../docs/recon-schemas.js';
import { requireApiKey } from '../middleware/auth.js';
import { runRecon, type Queryable } from '../recon/recon.js';

// HTTP surface of the reconciliation job (DESIGN §9). NOT wired into server.ts
// here — the integration wave registers it:
//   await registerReconRoutes(app);
// The endpoint is read-only by construction: recon reports, it never edits.
// Corrections are future compensating entries posted by ops, never a mutation.

export interface ReconRouteOptions {
  /** Injectable for tests; defaults to the process-wide pool. */
  db?: Queryable;
}

const querySchema = z.object({
  // one week of minutes is a generous ceiling; anything larger is a typo.
  maxAgeMinutes: z.coerce.number().int().positive().max(10_080).optional(),
});

export async function registerReconRoutes(
  app: FastifyInstance,
  options: ReconRouteOptions = {},
): Promise<void> {
  const db = options.db ?? pool;

  app.get(
    '/recon/report',
    { preHandler: requireApiKey, schema: reconReportSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid query', details: parsed.error.issues });
      }

      // request.log satisfies EventLogger, so every finding lands in the app's
      // structured log stream exactly like the money.* events do.
      const report = await runRecon(db, {
        maxAgeMinutes: parsed.data.maxAgeMinutes,
        logger: request.log,
      });

      return reply.send(report);
    },
  );
}
