import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';

const paramsSchema = z.object({ id: z.string().uuid() });

interface BalanceRow {
  account_id: string;
  available: string; // pg returns BIGINT as a string — kept as string, never a float
  pending: string;
  updated_at: string;
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:id/balance', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid account id' });
    }

    // spend_guards is the reservation counter (ADR-004/ADR-020); its buckets are
    // aliased back to the client-facing available/pending balance-view shape.
    const res = await pool.query<BalanceRow>(
      `SELECT account_id, headroom_minor AS available, pending_minor AS pending, updated_at
         FROM spend_guards
        WHERE account_id = $1`,
      [parsed.data.id],
    );

    const row = res.rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'account not found' });
    }

    // Amounts serialised as strings to preserve integer minor units exactly.
    return reply.send({
      accountId: row.account_id,
      available: row.available,
      pending: row.pending,
      updatedAt: row.updated_at,
    });
  });
}
