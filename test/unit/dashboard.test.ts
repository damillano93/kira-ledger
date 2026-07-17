import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerDashboardRoutes } from '../../src/routes/dashboard.js';

// Exercises the dashboard against the REAL test Postgres (global-setup brings it
// up on :5433 with migrations + seed applied), via app.inject — no listener.

describe('operations dashboard', () => {
  const app = Fastify();

  beforeAll(async () => {
    await registerDashboardRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close(); // NOTE: never end the shared pg pool (single fork suite)
  });

  it('GET /dashboard serves the self-contained HTML shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('KIRA LEDGER');
    expect(res.body).toContain('/dashboard/data'); // polls the data endpoint
    // Self-contained: no external scripts/styles (vanilla, zero CDN).
    expect(res.body).not.toMatch(/<script[^>]+src=/i);
    expect(res.body).not.toMatch(/<link[^>]+href=/i);
  });

  it('GET /dashboard/data returns balances with a LIVE recon check', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/data' });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    // Balances: at least the three seeded accounts, each with guard buckets AND
    // the ledger-derived SUM(entries) side by side.
    expect(data.balances.length).toBeGreaterThanOrEqual(3);
    for (const b of data.balances) {
      expect(b).toMatchObject({
        accountId: expect.any(String),
        name: expect.any(String),
        kind: expect.any(String),
        currency: expect.any(String),
        available: expect.stringMatching(/^-?\d+$/),
        pending: expect.stringMatching(/^-?\d+$/),
        guardTotal: expect.stringMatching(/^-?\d+$/),
        ledger: expect.stringMatching(/^-?\d+$/),
      });
      // recon verdict: boolean for tracked (user/fee) accounts, null otherwise.
      if (b.tracked) expect(typeof b.reconOk).toBe('boolean');
      else expect(b.reconOk).toBeNull();
    }

    // The invariant itself must HOLD — guard (available+pending) ==
    // -SUM(entries) [liability-normal side] — for accounts whose balances were
    // built purely through the ledger. That is exactly the seeded accounts;
    // OTHER test fixtures seed spend_guards directly (bypassing entries), and
    // the dashboard rightly flags those as mismatches — which is the point.
    const seededTracked = data.balances.filter(
      (b: { accountId: string; tracked: boolean }) =>
        b.tracked && b.accountId.startsWith('00000000-0000-0000-0000-'),
    );
    expect(seededTracked.length).toBeGreaterThanOrEqual(2); // seeded user + fee
    for (const b of seededTracked) expect(b.reconOk, `recon for ${b.name}`).toBe(true);

    // Fees + transfers sections have the expected shape.
    expect(Array.isArray(data.fees.totals)).toBe(true);
    expect(Array.isArray(data.fees.recent)).toBe(true);
    expect(Array.isArray(data.transfers)).toBe(true);
    expect(data.transfers.length).toBeLessThanOrEqual(50);

    // Routing section is DEFENSIVE: an array (possibly empty) whether or not
    // migration 004's tables exist in this database yet.
    expect(Array.isArray(data.routing)).toBe(true);
  });
});
