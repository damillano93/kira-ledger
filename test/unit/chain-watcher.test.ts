import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { CHAIN, pollOnce, setOnOfframpConfirmed, type OfframpConfirmedEvent } from '../../src/chain/watcher.js';
import type { ChainRpc, SignatureInfoView, SignatureStatusView } from '../../src/chain/rpc.js';
import type { ParsedTransactionView } from '../../src/chain/parser.js';
import { recordDeposit } from '../../src/domain/offramp.js';
import { createAccount, getBalance } from '../helpers/db.js';

// Watcher specs: RPC is fully MOCKED (never a devnet call in tests); Postgres is
// the real test database, because the watcher's idempotency guarantees ARE
// Postgres rows — mocking the DB would test nothing.

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Valid base58 keys, generated offline — deriveDepositAta needs real curve points.
const MINT = Keypair.generate().publicKey.toBase58();
const DEPOSIT_OWNER = Keypair.generate().publicKey.toBase58();

interface MockChainState {
  signatures: SignatureInfoView[];
  txs: Map<string, ParsedTransactionView>;
  statuses: Map<string, SignatureStatusView>;
}

function makeRpc(state: MockChainState): ChainRpc {
  return {
    async getSignaturesForAddress() {
      return state.signatures;
    },
    async getParsedTransaction(signature) {
      return state.txs.get(signature) ?? null;
    },
    async getSignatureStatuses(signatures) {
      return signatures.map((s) => state.statuses.get(s) ?? null);
    },
  };
}

function depositTx(amountMinor: bigint, slot: number): ParsedTransactionView {
  return {
    slot,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: DEPOSIT_OWNER,
          uiTokenAmount: { amount: amountMinor.toString(), decimals: 6 },
        },
      ],
    },
  };
}

// Fresh accounts per spec (isolation without truncation) + a unique signature.
async function scenario() {
  const external = await createAccount('external', { currency: 'USDC' });
  const user = await createAccount('user');
  const fee = await createAccount('fee');
  const signature = `sig-${randomUUID()}`;
  const state: MockChainState = { signatures: [], txs: new Map(), statuses: new Map() };
  const options = {
    rpc: makeRpc(state),
    mint: MINT,
    depositOwner: DEPOSIT_OWNER,
    confirmations: 12,
    feeBps: 100,
    externalAccountId: external.id,
    userAccountId: user.id,
    feeAccountId: fee.id,
    logger: silentLogger,
  };
  return { external, user, fee, signature, state, options };
}

async function chainEvent(signature: string) {
  const res = await pool.query<{ status: string; amount_minor: string }>(
    `SELECT status, amount_minor FROM chain_events WHERE chain = $1 AND signature = $2`,
    [CHAIN, signature],
  );
  return res.rows[0] ?? null;
}

async function transferCount(idempotencyKey: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM transfers WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return Number(res.rows[0]?.n ?? '0');
}

// NOTE: the pool is shared across every spec file in the single-fork run — it
// is never closed here (same convention as the integration specs).
afterEach(() => setOnOfframpConfirmed(null));

describe('chain watcher: detection', () => {
  it('books a detected deposit to PENDING only and persists the chain event', async () => {
    const { user, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    // seen at 'confirmed' but nowhere near final:
    state.statuses.set(signature, { confirmations: 3, confirmationStatus: 'confirmed', err: null });

    await pollOnce(options);

    expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });
    expect(await chainEvent(signature)).toEqual({ status: 'detected', amount_minor: '5000000000' });
  });

  it('re-scanning the same signature is a total no-op (persistent dedupe)', async () => {
    const { user, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: 1, confirmationStatus: 'confirmed', err: null });

    await pollOnce(options);
    await pollOnce(options); // watcher restart / overlap re-scan
    await pollOnce(options);

    expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });
    expect(await transferCount(`${CHAIN}:${signature}`)).toBe(1);
    const events = await pool.query(
      `SELECT COUNT(*)::text AS n FROM chain_events WHERE chain = $1 AND signature = $2`,
      [CHAIN, signature],
    );
    expect(events.rows[0].n).toBe('1');
  });

  it('ignores failed transactions and outbound movements', async () => {
    const { user, signature, state, options } = await scenario();
    const outSig = `sig-${randomUUID()}`;
    state.signatures = [
      { signature, slot: 100, err: { InstructionError: [0, 'Custom'] } }, // failed tx
      { signature: outSig, slot: 101, err: null }, // outbound sweep
    ];
    state.txs.set(outSig, {
      slot: 101,
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 1, mint: MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: '900', decimals: 6 } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: '0', decimals: 6 } },
        ],
      },
    });

    await pollOnce(options);

    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 0n });
    expect(await chainEvent(signature)).toBeNull();
    expect(await chainEvent(outSig)).toBeNull();
  });

  it('dedupes against a deposit already booked by the WEBHOOK (same key shape)', async () => {
    const { external, user, signature, state, options } = await scenario();
    // The webhook route got there first with its `${chain}:${txHash}` key:
    await withTx((c) =>
      recordDeposit(c, {
        idempotencyKey: `${CHAIN}:${signature}`,
        externalAccountId: external.id,
        userAccountId: user.id,
        amount: 5_000_000_000n,
        currency: 'USDC',
      }),
    );
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: 2, confirmationStatus: 'confirmed', err: null });

    await pollOnce(options);

    // chain_events row now exists (the watcher's statement row) but the ledger
    // was NOT double-credited: one transfer, pending counted once.
    expect(await chainEvent(signature)).not.toBeNull();
    expect(await transferCount(`${CHAIN}:${signature}`)).toBe(1);
    expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });
  });
});

describe('chain watcher: confirmation threshold and USDC->USD credit', () => {
  it('does NOT credit below the confirmation threshold', async () => {
    const { user, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: 11, confirmationStatus: 'confirmed', err: null });

    await pollOnce(options);
    await pollOnce(options);

    expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });
    expect((await chainEvent(signature))?.status).toBe('detected');
  });

  it('credits at FINALIZED: pending USDC drains, USD available = net, fee itemised', async () => {
    const { user, fee, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: 5, confirmationStatus: 'confirmed', err: null });

    const events: OfframpConfirmedEvent[] = [];
    setOnOfframpConfirmed((e) => {
      events.push(e);
    });

    await pollOnce(options); // detect only
    expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });

    // chain finalizes (Solana reports rooted txs as confirmations=null)
    state.statuses.set(signature, { confirmations: null, confirmationStatus: 'finalized', err: null });
    await pollOnce(options);

    // 5,000 USDC (6dp) -> 500,000 cents; 1% fee = 5,000; net = 495,000 cents.
    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 495_000n });
    expect((await getBalance(fee.id))?.available).toBe(5_000n);
    expect((await chainEvent(signature))?.status).toBe('credited');

    // deposit transfer marked confirmed
    const dep = await pool.query<{ status: string }>(
      `SELECT status FROM transfers WHERE idempotency_key = $1`,
      [`${CHAIN}:${signature}`],
    );
    expect(dep.rows[0]?.status).toBe('confirmed');

    // routing hook fired exactly once, post-commit, with the full quote
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chain: CHAIN,
      signature,
      userAccountId: user.id,
      quote: {
        grossUsdcMinor: 5_000_000_000n,
        grossUsdCents: 500_000n,
        feeUsdCents: 5_000n,
        netUsdCents: 495_000n,
      },
    });
  });

  it('credits via SLOT-DEPTH when confirmations >= threshold without finalized status', async () => {
    const { user, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(1_000_000n, 100)); // 1 USDC
    state.statuses.set(signature, { confirmations: 15, confirmationStatus: 'confirmed', err: null });

    await pollOnce(options); // detects AND credits within the same tick
    // 1 USDC -> 100 cents, 1% fee = 1 cent, net 99
    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 99n });
  });

  it('confirmation is idempotent: further polls never double-credit or re-fire the hook', async () => {
    const { user, fee, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: null, confirmationStatus: 'finalized', err: null });

    let hookCalls = 0;
    setOnOfframpConfirmed(() => {
      hookCalls += 1;
    });

    await pollOnce(options);
    await pollOnce(options);
    await pollOnce(options);

    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 495_000n });
    expect((await getBalance(fee.id))?.available).toBe(5_000n);
    expect(await transferCount(`${CHAIN}:${signature}:offramp`)).toBe(1);
    expect(hookCalls).toBe(1);
  });

  it('a hook failure does not undo the credit and does not crash the poll', async () => {
    const { user, signature, state, options } = await scenario();
    state.signatures = [{ signature, slot: 100, err: null }];
    state.txs.set(signature, depositTx(5_000_000_000n, 100));
    state.statuses.set(signature, { confirmations: null, confirmationStatus: 'finalized', err: null });

    setOnOfframpConfirmed(() => {
      throw new Error('routing exploded');
    });

    await expect(pollOnce(options)).resolves.toBeUndefined();
    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 495_000n });
  });

  it('an RPC failure surfaces as a rejected tick (backoff path) without corrupting state', async () => {
    const { user, options } = await scenario();
    const failingRpc: ChainRpc = {
      getSignaturesForAddress: async () => {
        throw new Error('429 Too Many Requests');
      },
      getParsedTransaction: async () => null,
      getSignatureStatuses: async () => [],
    };

    await expect(pollOnce({ ...options, rpc: failingRpc })).rejects.toThrow(/429/);
    expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 0n });
  });
});
