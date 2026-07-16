// Pure transaction parser: given a parsed Solana transaction, how much of the
// watched SPL mint landed in the deposit owner's token account(s)?
//
// Strategy: diff meta.preTokenBalances / meta.postTokenBalances filtered by
// (mint, owner) instead of walking instructions. This is deliberately the
// robust path: it captures plain `transfer`, `transferChecked`, transfers
// buried in inner instructions (CPI), and multiple transfers in one tx — the
// net effect on the account is what the ledger cares about. A negative or zero
// delta (outbound sweep, unrelated tx touching the ATA) yields null.
//
// The types below are narrow STRUCTURAL views of @solana/web3.js's
// ParsedTransactionWithMeta — the real client maps into them, and unit tests
// build fixtures without dragging the whole web3 type surface in.

export interface TokenBalanceView {
  accountIndex: number;
  mint: string;
  owner?: string | undefined;
  uiTokenAmount: {
    amount: string; // raw integer minor units as a string — never a float
    decimals: number;
  };
}

export interface ParsedTransactionView {
  slot: number;
  meta: {
    err: unknown; // non-null => tx failed on chain; never credit it
    preTokenBalances?: TokenBalanceView[] | null;
    postTokenBalances?: TokenBalanceView[] | null;
  } | null;
}

export interface SplDeposit {
  amountMinor: bigint; // net inbound minor units (USDC = 6dp)
  decimals: number;
  slot: number;
}

// Sum minor units across all of the owner's token accounts for the mint.
// (An owner normally has one ATA, but nothing on chain forbids more.)
function sumFor(balances: TokenBalanceView[] | null | undefined, mint: string, owner: string) {
  let total = 0n;
  let decimals: number | null = null;
  for (const b of balances ?? []) {
    if (b.mint === mint && b.owner === owner) {
      total += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
  }
  return { total, decimals };
}

// Extract the net deposit of `mint` to `owner` from a parsed transaction.
// Returns null when the tx failed, has no metadata, or the net delta is <= 0.
export function parseSplDeposit(
  tx: ParsedTransactionView,
  filter: { mint: string; owner: string },
): SplDeposit | null {
  if (!tx.meta || tx.meta.err !== null) return null;

  const pre = sumFor(tx.meta.preTokenBalances, filter.mint, filter.owner);
  const post = sumFor(tx.meta.postTokenBalances, filter.mint, filter.owner);

  const delta = post.total - pre.total;
  if (delta <= 0n) return null;

  return {
    amountMinor: delta,
    decimals: post.decimals ?? pre.decimals ?? 0,
    slot: tx.slot,
  };
}
