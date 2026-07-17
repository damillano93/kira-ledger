import { describe, expect, it } from 'vitest';
import { parseSplDeposit, type ParsedTransactionView } from '../../src/chain/parser.js';

// Parser specs run on fabricated transaction fixtures — no RPC, no devnet.
// The parser diffs pre/post token balances for (mint, owner): the net effect
// is what the ledger books, regardless of how many instructions produced it.

const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_MINT = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 'OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_OWNER = 'OwnerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function tx(
  pre: Array<{ mint: string; owner: string; amount: string }>,
  post: Array<{ mint: string; owner: string; amount: string }>,
  overrides: { err?: unknown; slot?: number } = {},
): ParsedTransactionView {
  const toBalance = (b: { mint: string; owner: string; amount: string }, i: number) => ({
    accountIndex: i,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { amount: b.amount, decimals: 6 },
  });
  return {
    slot: overrides.slot ?? 100,
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: pre.map(toBalance),
      postTokenBalances: post.map(toBalance),
    },
  };
}

describe('parseSplDeposit', () => {
  it('extracts a simple inbound transfer (5,000 USDC in 6dp minor units)', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OWNER, amount: '0' }],
        [{ mint: MINT, owner: OWNER, amount: '5000000000' }],
        { slot: 424242 },
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toEqual({ amountMinor: 5_000_000_000n, decimals: 6, slot: 424242 });
  });

  it('handles a missing pre-balance (fresh ATA funded in the same tx)', () => {
    const parsed = parseSplDeposit(
      tx([], [{ mint: MINT, owner: OWNER, amount: '250000000' }]),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed?.amountMinor).toBe(250_000_000n);
  });

  it('nets multiple movements in one transaction (one Solana tx, several SPL transfers)', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OWNER, amount: '1000000' }],
        [{ mint: MINT, owner: OWNER, amount: '4000000' }],
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed?.amountMinor).toBe(3_000_000n);
  });

  it('ignores transfers of a DIFFERENT mint to the same owner (wrong-token guard)', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: OTHER_MINT, owner: OWNER, amount: '0' }],
        [{ mint: OTHER_MINT, owner: OWNER, amount: '5000000000' }],
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toBeNull();
  });

  it('ignores transfers of the mint to a DIFFERENT owner (wrong-address guard)', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OTHER_OWNER, amount: '0' }],
        [{ mint: MINT, owner: OTHER_OWNER, amount: '5000000000' }],
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toBeNull();
  });

  it('ignores OUTBOUND movements (negative delta) — a sweep is not a deposit', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OWNER, amount: '5000000000' }],
        [{ mint: MINT, owner: OWNER, amount: '0' }],
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toBeNull();
  });

  it('ignores zero-delta transactions touching the account', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OWNER, amount: '77' }],
        [{ mint: MINT, owner: OWNER, amount: '77' }],
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toBeNull();
  });

  it('NEVER credits a transaction that failed on-chain', () => {
    const parsed = parseSplDeposit(
      tx(
        [{ mint: MINT, owner: OWNER, amount: '0' }],
        [{ mint: MINT, owner: OWNER, amount: '5000000000' }],
        { err: { InstructionError: [0, 'Custom'] } },
      ),
      { mint: MINT, owner: OWNER },
    );
    expect(parsed).toBeNull();
  });

  it('returns null when metadata is missing entirely', () => {
    expect(parseSplDeposit({ slot: 1, meta: null }, { mint: MINT, owner: OWNER })).toBeNull();
  });
});
