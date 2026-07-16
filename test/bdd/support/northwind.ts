import { randomUUID } from 'node:crypto';
import { pool, withTx } from '../../../src/db.js';
import { confirmOfframp, recordDeposit } from '../../../src/domain/offramp.js';
import { buildRegistry, type ProviderRegistry } from '../../../src/vendors/registry.js';
import { createAccount, type TestAccount } from '../../helpers/db.js';

// Shared Northwind world for the BDD features.
//
// The Northwind standing route is seeded once by migration 004 against the
// shared demo account ...002. The suite runs against ONE shared Postgres, so
// every scenario mints its OWN accounts and an exact MIRROR of that route
// (same providers, same amounts, same conversion-pair shape) — the semantics
// under specification are identical, the isolation is total.

// -- The Northwind numbers, in exact minor units ------------------------------

export const DEPOSIT_USDC_MINOR = 5_000_000_000n; // 5,000.000000 USDC (6dp)
export const FEE_BPS = 100; // 1%
export const GROSS_USD_CENTS = 500_000n; // $5,000.00 at the 1:1 par
export const FEE_USD_CENTS = 5_000n; // $50.00 itemised fee
export const NET_USD_CENTS = 495_000n; // $4,950.00 spendable

export const ACH_USD_CENTS = 420_000n; // leg 1: $4,200.00 to the roaster
export const USDT_MINOR = 600_000_000n; // leg 2: 600.000000 USDT (6dp)
export const USDT_COST_USD_CENTS = 60_000n; // debiting $600.00 at the 1:1 peg
export const ROUTE_TOTAL_USD_CENTS = ACH_USD_CENTS + USDT_COST_USD_CENTS; // $4,800.00

export interface NorthwindWorld {
  user: TestAccount;
  externalUsdc: TestAccount;
  fee: TestAccount;
  achDestination: TestAccount;
  usdtDestination: TestAccount;
  routeId: string;
}

// Fresh accounts + a per-scenario mirror of the seeded Northwind route.
export async function seedNorthwindWorld(): Promise<NorthwindWorld> {
  const user = await createAccount('user');
  const externalUsdc = await createAccount('external', { currency: 'USDC' });
  const fee = await createAccount('fee');
  const achDestination = await createAccount('external');
  const usdtDestination = await createAccount('external', { currency: 'USDT' });
  const conversionUsd = await createAccount('liability'); // conversion pair, USD side
  const conversionUsdt = await createAccount('liability', { currency: 'USDT' });

  const routeId = randomUUID();
  await pool.query(
    `INSERT INTO routes (id, name, trigger_account_id, active) VALUES ($1, $2, $3, true)`,
    [routeId, `bdd-northwind-${routeId.slice(0, 8)}`, user.id],
  );
  await pool.query(
    `INSERT INTO route_actions (route_id, seq, provider, amount_minor, currency,
                                source_amount_minor, source_currency, destination_account_id,
                                source_conversion_account_id, destination_conversion_account_id)
     VALUES ($1, 1, 'acmepay', $2, 'USD', $2, 'USD', $3, NULL, NULL),
            ($1, 2, 'polygon-usdt', $4, 'USDT', $5, 'USD', $6, $7, $8)`,
    [
      routeId,
      ACH_USD_CENTS.toString(),
      achDestination.id,
      USDT_MINOR.toString(),
      USDT_COST_USD_CENTS.toString(),
      usdtDestination.id,
      conversionUsd.id,
      conversionUsdt.id,
    ],
  );

  return { user, externalUsdc, fee, achDestination, usdtDestination, routeId };
}

// Fund the world's user via a same-currency USD off-ramp (deposit + confirm),
// returning the CONFIRMED off-ramp transfer id — a valid route trigger.
export async function fundViaOfframp(
  world: NorthwindWorld,
  grossCents: bigint,
  feeCents: bigint,
): Promise<string> {
  const key = `bdd:fund:${randomUUID()}`;
  const deposit = await withTx((client) =>
    recordDeposit(client, {
      idempotencyKey: key,
      externalAccountId: world.externalUsdc.id,
      userAccountId: world.user.id,
      amount: grossCents,
      currency: 'USD',
    }),
  );
  const offramp = await withTx((client) =>
    confirmOfframp(client, {
      idempotencyKey: `${key}:offramp`,
      depositTransferId: deposit.transfer.id,
      userAccountId: world.user.id,
      feeAccountId: world.fee.id,
      amount: grossCents,
      feeAmount: feeCents,
      currency: 'USD',
    }),
  );
  return offramp.transfer.id;
}

// Isolated provider registry per scenario (the mocks keep in-memory payout
// state). Polygon settles instantly so the poll path is deterministic.
export function scenarioRegistry(): ProviderRegistry {
  return buildRegistry([
    { name: 'acmepay', adapter: 'acmepay' },
    { name: 'legacybank', adapter: 'legacybank' },
    { name: 'polygon-usdt', adapter: 'polygon-usdt', options: { settleDelayMs: 0 } },
  ]);
}
