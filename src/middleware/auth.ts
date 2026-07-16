import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Constant-time comparison to avoid leaking the key via timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// preHandler enforcing a static API key via `Authorization: Bearer <key>`
// (or the `x-api-key` header). Rejects with 401 on any mismatch.
export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;
  const apiKeyHeader = request.headers['x-api-key'];
  const provided = bearer ?? (typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined);

  if (!provided || !safeEqual(provided, config.API_KEY)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
