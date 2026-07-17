import { expect } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { onOfframpConfirmed, retryExecution } from '../../src/routing/engine.js';
import { getBalance } from '../helpers/db.js';
import { Feature, Scenario } from './support/bdd.js';
import {
  fundViaOfframp,
  ROUTE_TOTAL_USD_CENTS,
  seedNorthwindWorld,
  type NorthwindWorld,
} from './support/northwind.js';

// ADR-013: reservation is all-or-nothing in declared seq order. When the total
// does not fit, the execution parks in `insufficient_funds` — a VISIBLE state
// an operator can query and retry, never a silent drop, never a partial fill.

Feature('Insufficient funds is visible and retryable', () => {
  Scenario(
    'a route against a short account parks visibly with ZERO partial reservations, then proceeds after funding',
    async ({ Given, When, Then, And }) => {
      let world!: NorthwindWorld;
      let executionId!: string;

      await Given(
        'a client sub-account with the Northwind route ($4,800.00 total) but only $4,500.00 available',
        async () => {
          world = await seedNorthwindWorld();
          // Covers the $4,200.00 ACH leg ALONE — but not both legs.
          const trigger = await fundViaOfframp(world, 450_000n, 0n);
          const fired = await withTx((c) => onOfframpConfirmed(c, trigger, world.user.id));
          expect(fired).toHaveLength(1);
          executionId = fired[0]!.executionId;
          expect(fired[0]!.status).toBe('insufficient_funds');
        },
      );

      await Then('the execution is parked in the visible insufficient_funds state', async () => {
        const execution = await pool.query<{ status: string }>(
          `SELECT status FROM route_executions WHERE id = $1`,
          [executionId],
        );
        expect(execution.rows[0]!.status).toBe('insufficient_funds');
      });

      await And('NOT ONE cent was reserved and no leg rows survive (all-or-nothing)', async () => {
        // The partial ACH reservation was rolled back by the savepoint.
        expect((await getBalance(world.user.id))?.available).toBe(450_000n);
        const legs = await pool.query(`SELECT 1 FROM route_legs WHERE execution_id = $1`, [
          executionId,
        ]);
        expect(legs.rowCount).toBe(0);
      });

      await When('the account is funded with another $1,000.00 and the execution is retried', async () => {
        await fundViaOfframp(world, 100_000n, 0n); // available is now $5,500.00
        const retried = await withTx((c) => retryExecution(c, executionId));
        expect(retried?.status).toBe('reserved');
      });

      await Then('both legs are reserved and available = $5,500.00 - $4,800.00 = $700.00 exactly', async () => {
        const legs = await pool.query<{ seq: number; status: string }>(
          `SELECT seq, status FROM route_legs WHERE execution_id = $1 ORDER BY seq`,
          [executionId],
        );
        expect(legs.rows).toEqual([
          { seq: 1, status: 'reserved' },
          { seq: 2, status: 'reserved' },
        ]);
        expect((await getBalance(world.user.id))?.available).toBe(550_000n - ROUTE_TOTAL_USD_CENTS);
      });

      await And('a further retry of the now-reserved execution is a clean no-op (guarded transition)', async () => {
        expect(await withTx((c) => retryExecution(c, executionId))).toBeNull();
        expect((await getBalance(world.user.id))?.available).toBe(70_000n);
      });
    },
  );
});
