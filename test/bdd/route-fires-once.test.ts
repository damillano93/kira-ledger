import { expect } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { onOfframpConfirmed } from '../../src/routing/engine.js';
import { getBalance } from '../helpers/db.js';
import { Feature, Scenario } from './support/bdd.js';
import {
  fundViaOfframp,
  NET_USD_CENTS,
  ROUTE_TOTAL_USD_CENTS,
  seedNorthwindWorld,
  type NorthwindWorld,
} from './support/northwind.js';

// Guardrail R4 (ADR-013): UNIQUE(route_id, trigger_transfer_id). The watcher's
// post-commit hook, a webhook retry and a manual re-trigger all converge on the
// same insert — only the winner reserves funds; every other firing is a read.

Feature('Route fires exactly once per trigger', () => {
  Scenario(
    'a redelivered "off-ramp confirmed" event cannot fire the route twice',
    async ({ Given, When, And, Then }) => {
      let world!: NorthwindWorld;
      let trigger!: string;
      let firstExecutionId!: string;
      const expectedRemainder = NET_USD_CENTS - ROUTE_TOTAL_USD_CENTS; // 15,000 cents

      await Given('a client sub-account with the Northwind route and $4,950.00 available', async () => {
        world = await seedNorthwindWorld();
        trigger = await fundViaOfframp(world, 500_000n, 5_000n);
      });

      await When('the confirmed off-ramp triggers the route', async () => {
        const fired = await withTx((c) => onOfframpConfirmed(c, trigger, world.user.id));
        expect(fired).toHaveLength(1);
        expect(fired[0]!.status).toBe('reserved');
        firstExecutionId = fired[0]!.executionId;
      });

      await Then('both legs are reserved and available drops to exactly $150.00', async () => {
        expect((await getBalance(world.user.id))?.available).toBe(expectedRemainder);
      });

      await When('the SAME trigger is delivered again (hook re-fire / webhook retry)', async () => {
        const second = await withTx((c) => onOfframpConfirmed(c, trigger, world.user.id));
        expect(second).toHaveLength(1);
        expect(second[0]!.status).toBe('already_fired');
        // Not a new execution — the caller is pointed at the original one.
        expect(second[0]!.executionId).toBe(firstExecutionId);
      });

      await Then('there is still exactly ONE execution with exactly TWO legs', async () => {
        const executions = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM route_executions
            WHERE route_id = $1 AND trigger_transfer_id = $2`,
          [world.routeId, trigger],
        );
        expect(executions.rows[0]!.n).toBe('1');

        const legs = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM route_legs WHERE execution_id = $1`,
          [firstExecutionId],
        );
        expect(legs.rows[0]!.n).toBe('2');
      });

      await And('not one extra cent was reserved — available is still exactly $150.00', async () => {
        expect((await getBalance(world.user.id))?.available).toBe(expectedRemainder);
      });
    },
  );
});
