import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { withTx } from '../db.js';
import { recordDeposit } from '../domain/offramp.js';

// Inbound chain webhook. Body carries a detected on-chain deposit. Security:
//   * HMAC-SHA256(WEBHOOK_SECRET, rawBody) must match the `x-signature` header.
//   * `x-timestamp` must be within a freshness window (replay protection).
// Idempotency: the tx hash is the idempotency key, so redelivery is a no-op.

const REPLAY_WINDOW_SECONDS = 300;

const bodySchema = z.object({
  txHash: z.string().min(1),
  chain: z.string().min(1),
  // integer minor units transmitted as a string — never a float.
  amount: z.string().regex(/^\d+$/, 'amount must be integer minor units as a string'),
  currency: z.string().min(1),
  userAccountId: z.string().uuid(),
  externalAccountId: z.string().uuid(),
});

function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', config.WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function timestampFresh(raw: string | undefined): boolean {
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Date.now() / 1000;
  return Math.abs(nowSeconds - ts) <= REPLAY_WINDOW_SECONDS;
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/chain', async (request: FastifyRequest, reply: FastifyReply) => {
    // rawBody is captured by the content-type parser registered in server.ts.
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';

    if (!timestampFresh(request.headers['x-timestamp'] as string | undefined)) {
      return reply.code(401).send({ error: 'stale or missing timestamp' });
    }
    if (!verifySignature(rawBody, request.headers['x-signature'] as string | undefined)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid payload', details: parsed.error.issues });
    }
    const body = parsed.data;

    // tx hash is the idempotency guardrail: a redelivered webhook returns the
    // same transfer without double-crediting.
    const idempotencyKey = `${body.chain}:${body.txHash}`;

    const result = await withTx((client) =>
      recordDeposit(client, {
        idempotencyKey,
        externalAccountId: body.externalAccountId,
        userAccountId: body.userAccountId,
        amount: BigInt(body.amount),
        currency: body.currency,
      }),
    );

    return reply.code(result.created ? 201 : 200).send({
      transferId: result.transfer.id,
      status: result.transfer.status,
      idempotent: !result.created,
    });
  });
}
