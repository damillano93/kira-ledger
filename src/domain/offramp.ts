import type { PoolClient } from '../db.js';
import {
  createBalancedTransfer,
  setTransferStatus,
  type CreateTransferResult,
  type Posting,
} from './ledger.js';

// Off-ramp flow: a stablecoin deposit is first booked as PENDING (not spendable),
// then — once enough confirmations arrive — cleared into AVAILABLE with fees
// itemised to the fee account. pending and available are always DISTINCT buckets.

export interface DepositInput {
  idempotencyKey: string; // derived from (chain, tx hash) upstream — idempotent per deposit
  externalAccountId: string; // source-of-funds mirror (external/asset account)
  userAccountId: string; // the client sub-account being credited
  amount: bigint; // gross minor units received
  currency: string;
}

// Book a detected deposit. Credits the user's PENDING bucket; available is
// untouched (the money is seen, not yet collected — a reorg could still undo it).
export async function recordDeposit(
  client: PoolClient,
  input: DepositInput,
): Promise<CreateTransferResult> {
  const { idempotencyKey, externalAccountId, userAccountId, amount, currency } = input;
  if (amount <= 0n) throw new Error('deposit amount must be positive');

  const postings: Posting[] = [
    // Debit the external source mirror (no materialised spendable bucket here).
    { accountId: externalAccountId, amount: amount, currency },
    // Credit the client's claim into pending.
    {
      accountId: userAccountId,
      amount: -amount,
      currency,
      balance: { bucket: 'pending', delta: amount },
    },
  ];

  return createBalancedTransfer(client, {
    idempotencyKey,
    kind: 'deposit',
    status: 'pending',
    postings,
  });
}

export interface ConfirmInput {
  idempotencyKey: string; // e.g. `${depositKey}:offramp`
  depositTransferId: string; // the deposit being cleared (marked confirmed)
  userAccountId: string;
  feeAccountId: string;
  amount: bigint; // gross amount previously booked to pending
  feeAmount: bigint; // total itemised fees (>= 0, < amount)
  currency: string;
}

// Clear a confirmed deposit: move pending -> available minus fees, itemising the
// fee to the fee account. This is a NEW transfer (append-only): pending/available
// coexist because the state change is a new balanced transaction, never a mutation.
export async function confirmOfframp(
  client: PoolClient,
  input: ConfirmInput,
): Promise<CreateTransferResult> {
  const { idempotencyKey, depositTransferId, userAccountId, feeAccountId, amount, feeAmount, currency } =
    input;
  if (amount <= 0n) throw new Error('offramp amount must be positive');
  if (feeAmount < 0n || feeAmount >= amount) throw new Error('fee must be >= 0 and < amount');

  const net = amount - feeAmount;

  const postings: Posting[] = [
    // Drain the client's pending claim (debit the liability's pending bucket).
    {
      accountId: userAccountId,
      amount: amount,
      currency,
      balance: { bucket: 'pending', delta: -amount },
    },
    // Credit the net into the client's available (spendable) bucket.
    {
      accountId: userAccountId,
      amount: -net,
      currency,
      balance: { bucket: 'available', delta: net },
    },
    // Itemise the fee to the fee account's available bucket.
    {
      accountId: feeAccountId,
      amount: -feeAmount,
      currency,
      balance: { bucket: 'available', delta: feeAmount },
    },
  ];

  const result = await createBalancedTransfer(client, {
    idempotencyKey,
    kind: 'offramp',
    status: 'confirmed',
    postings,
  });

  if (result.created) {
    await setTransferStatus(client, depositTransferId, 'confirmed');
  }

  return result;
}

// ---------------------------------------------------------------------------
// USDC -> USD conversion (the real off-ramp leg).
// ---------------------------------------------------------------------------
//
// Rate: 1 USDC = 1 USD, stablecoin par. The conversion is therefore purely a
// DECIMALS problem: USDC has 6 decimal places, USD (cents) has 2, so the scale
// factor is 10^4 minor units of USDC per cent. 5,000 USDC = 5_000_000_000 (6dp)
// -> 500_000 cents, exactly.
//
// Rounding policy, made explicit:
//   * The par conversion FLOORS to the cent — we never credit a fraction of a
//     cent that USD cannot represent, so rounding can never create money. The
//     sub-cent residue (< 100th of a cent per deposit) stays as the conversion
//     account's net position: observable in recon, never hidden in a client
//     amount (ADR-008's residue rule).
//   * The basis-point FEE division rounds HALF-EVEN (banker's), per ADR-008:
//     raw truncation would bias the dust systematically in the house's favour.

// Seeded in migration 003. Balances both currency legs of every conversion.
export const CONVERSION_ACCOUNT_ID = '00000000-0000-0000-0000-000000000020';

const USDC_DECIMALS = 6n;
const USD_DECIMALS = 2n;
const USDC_MINOR_PER_CENT = 10n ** (USDC_DECIMALS - USD_DECIMALS); // 10_000

// Par conversion, floored to the cent (see policy above). Pure; integers only.
export function usdcMinorToUsdCents(usdcMinor: bigint): bigint {
  if (usdcMinor < 0n) throw new Error('usdc amount must not be negative');
  return usdcMinor / USDC_MINOR_PER_CENT; // BigInt division truncates = floor for >= 0
}

// amount * bps / 10_000 with round-half-even on the final division (ADR-008).
// ADR-008's worked tie: 50 bps of 44_500 cents = 222.5 -> 222 (half-up would say 223).
export function feeFromBps(amountMinor: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error('feeBps must be an integer in [0, 10000]');
  }
  if (amountMinor < 0n) throw new Error('amount must not be negative');
  const numerator = amountMinor * BigInt(feeBps);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder < denominator) return quotient;
  if (twiceRemainder > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n; // exact tie: round to even
}

export interface ConversionQuote {
  grossUsdcMinor: bigint; // what was deposited, 6dp
  grossUsdCents: bigint; // par value floored to the cent, 2dp
  feeUsdCents: bigint; // itemised fee on the USD leg
  netUsdCents: bigint; // what the client can actually spend
}

// Pure quote: all the arithmetic in one testable place, none of it in SQL.
export function quoteUsdcToUsd(grossUsdcMinor: bigint, feeBps: number): ConversionQuote {
  if (grossUsdcMinor <= 0n) throw new Error('conversion amount must be positive');
  const grossUsdCents = usdcMinorToUsdCents(grossUsdcMinor);
  if (grossUsdCents <= 0n) {
    // Sub-cent dust deposit: nothing creditable in USD. Refuse loudly rather
    // than write a zero-amount ledger leg.
    throw new Error('deposit too small to convert: rounds to zero USD cents');
  }
  const feeUsdCents = feeFromBps(grossUsdCents, feeBps);
  const netUsdCents = grossUsdCents - feeUsdCents;
  if (netUsdCents < 0n) throw new Error('fee exceeds converted amount');
  return { grossUsdcMinor, grossUsdCents, feeUsdCents, netUsdCents };
}

export interface ConfirmConvertedInput {
  idempotencyKey: string; // e.g. `${chain}:${signature}:offramp`
  depositTransferId: string; // the pending USDC deposit being cleared
  userAccountId: string;
  feeAccountId: string;
  conversionAccountId?: string; // defaults to the seeded conversion account
  grossUsdcMinor: bigint; // exactly what recordDeposit booked to pending (6dp)
  feeBps: number;
}

export interface ConfirmConvertedResult extends CreateTransferResult {
  quote: ConversionQuote;
}

// Clear a confirmed USDC deposit into spendable USD (ADR-007: available is
// credited at CHAIN confirmation — Kira lends the float until fiat settles).
// One append-only transfer with two independently-balanced currency legs
// (the DB trigger enforces SUM = 0 PER currency):
//
//   USDC leg (6dp):  user  +gross   (drains the pending claim booked at detect)
//                    conv  -gross   (conversion account absorbs the USDC)
//   USD  leg (2dp):  conv  +grossUsd
//                    user  -netUsd  (available bucket += net — spendable now)
//                    fee   -feeUsd  (itemised, never netted invisibly)
//
// NOTE on buckets: the user's pending bucket holds the USDC claim in USDC minor
// units from detect until confirm; available holds USD cents. This transfer
// drains pending by exactly what recordDeposit added, so the buckets never mix.
// Idempotent: replaying the same key returns the stored transfer, no re-posting.
export async function confirmOfframpConverted(
  client: PoolClient,
  input: ConfirmConvertedInput,
): Promise<ConfirmConvertedResult> {
  const {
    idempotencyKey,
    depositTransferId,
    userAccountId,
    feeAccountId,
    conversionAccountId = CONVERSION_ACCOUNT_ID,
    grossUsdcMinor,
    feeBps,
  } = input;

  const quote = quoteUsdcToUsd(grossUsdcMinor, feeBps);

  const postings: Posting[] = [
    // --- USDC leg ---
    {
      accountId: userAccountId,
      amount: quote.grossUsdcMinor,
      currency: 'USDC',
      balance: { bucket: 'pending', delta: -quote.grossUsdcMinor },
    },
    { accountId: conversionAccountId, amount: -quote.grossUsdcMinor, currency: 'USDC' },
    // --- USD leg ---
    { accountId: conversionAccountId, amount: quote.grossUsdCents, currency: 'USD' },
  ];

  // Zero-amount lines (feeBps=0, or feeBps=10000 leaving net=0) are omitted
  // rather than posted as meaningless zero entries to the append-only ledger.
  // gross > 0 is guaranteed by the quote, so the USD leg always has substance.
  if (quote.netUsdCents > 0n) {
    postings.push({
      accountId: userAccountId,
      amount: -quote.netUsdCents,
      currency: 'USD',
      balance: { bucket: 'available', delta: quote.netUsdCents },
    });
  }
  if (quote.feeUsdCents > 0n) {
    postings.push({
      accountId: feeAccountId,
      amount: -quote.feeUsdCents,
      currency: 'USD',
      balance: { bucket: 'available', delta: quote.feeUsdCents },
    });
  }

  const result = await createBalancedTransfer(client, {
    idempotencyKey,
    kind: 'offramp',
    status: 'confirmed',
    postings,
  });

  if (result.created) {
    await setTransferStatus(client, depositTransferId, 'confirmed');
  }

  return { ...result, quote };
}
