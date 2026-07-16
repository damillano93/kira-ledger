import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { ParsedTransactionView } from './parser.js';

// Thin RPC port (DESIGN §7.2's ChainGateway, sized to what the watcher needs).
// The watcher depends on THIS interface, never on Connection directly — unit
// tests substitute an in-memory fake; devnet flakiness stays behind one seam.

export interface SignatureInfoView {
  signature: string;
  slot: number;
  err: unknown; // non-null => the tx failed; the watcher skips it
}

export interface SignatureStatusView {
  // Number of confirmed blocks on top of the tx's block; null once the cluster
  // has ROOTED (finalized) the tx — Solana reports finality as confirmations=null.
  confirmations: number | null;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | undefined;
  err: unknown;
}

export interface ChainRpc {
  // Signatures that touched `address`, newest first, at 'confirmed' commitment
  // (detection wants to see deposits early; crediting waits for finality).
  getSignaturesForAddress(address: string, limit: number): Promise<SignatureInfoView[]>;
  getParsedTransaction(signature: string): Promise<ParsedTransactionView | null>;
  getSignatureStatuses(signatures: string[]): Promise<(SignatureStatusView | null)[]>;
}

// Derive the SPL associated token account that receives deposits. Pure — no RPC.
export function deriveDepositAta(mint: string, owner: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner)).toBase58();
}

// Real implementation against a Solana JSON-RPC node (devnet by default).
export function createSolanaRpc(url: string): ChainRpc {
  const connection = new Connection(url, 'confirmed');

  return {
    async getSignaturesForAddress(address, limit) {
      const infos = await connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit },
        'confirmed',
      );
      return infos.map((i) => ({ signature: i.signature, slot: i.slot, err: i.err }));
    },

    async getParsedTransaction(signature) {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return null;
      // Map into the narrow structural view the parser consumes.
      return {
        slot: tx.slot,
        meta: tx.meta
          ? {
              err: tx.meta.err,
              preTokenBalances: tx.meta.preTokenBalances ?? null,
              postTokenBalances: tx.meta.postTokenBalances ?? null,
            }
          : null,
      };
    },

    async getSignatureStatuses(signatures) {
      // searchTransactionHistory: older signatures fall out of the recent-status
      // cache; without this flag a finalized-but-old deposit reads as null.
      const res = await connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: true,
      });
      return res.value.map((v) =>
        v
          ? {
              confirmations: v.confirmations,
              confirmationStatus: v.confirmationStatus,
              err: v.err,
            }
          : null,
      );
    },
  };
}
