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
