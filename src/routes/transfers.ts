import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db.js';
import { docRouteOptions, payoutSchema } from '../docs/openapi.js';
import { createPayout, InsufficientFundsError } from '../domain/ledger.js';
import { requireApiKey } from '../middleware/auth.js';

// Outbound payout endpoint. Authenticated, zod-validated, and idempotent via the
// `idempotency-key` request header (same key => same payout, never a double-spend).

const bodySchema = z.object({
  userAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
  // integer minor units as a string — never a float.
  amount: z.string().regex(/^\d+$/, 'amount must be integer minor units as a string'),
  currency: z.string().min(1),
});

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/transfers/payout',
    { preHandler: requireApiKey, schema: payoutSchema, ...docRouteOptions },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: 'idempotency-key header is required' });
      }

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid payload', details: parsed.error.issues });
      }
      const body = parsed.data;

      try {
        const result = await withTx((client) =>
          createPayout(client, {
            idempotencyKey,
            userAccountId: body.userAccountId,
            destinationAccountId: body.destinationAccountId,
            amount: BigInt(body.amount),
            currency: body.currency,
          }),
        );

        return reply.code(result.created ? 201 : 200).send({
          transferId: result.transfer.id,
          status: result.transfer.status,
          idempotent: !result.created,
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          return reply.code(422).send({ error: 'insufficient funds', accountId: err.accountId });
        }
        throw err;
      }
    },
  );
}
