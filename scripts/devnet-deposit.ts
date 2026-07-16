// devnet-deposit.ts — fire the real E2E trigger: send test-USDC on Solana
// devnet to Kira's deposit wallet, exactly what a Northwind client would do.
//
//   Run:   npx tsx scripts/devnet-deposit.ts [amountUsdc]
//   e.g.:  npx tsx scripts/devnet-deposit.ts          # sends 5,000 USDC
//          npx tsx scripts/devnet-deposit.ts 250      # sends   250 USDC
//
// Requires scripts/devnet-setup.ts to have been run first (creates .devnet/).
// Prints the transaction signature: the running watcher should detect it within
// one poll interval and book the PENDING deposit; once finalized (~30s) it
// converts USDC -> USD and credits AVAILABLE minus fees.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, transferChecked } from '@solana/spl-token';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_DECIMALS = 6;

const here = dirname(fileURLToPath(import.meta.url));
const devnetDir = join(here, '..', '.devnet');

function loadKeypair(file: string): Keypair {
  const path = join(devnetDir, file);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run: npx tsx scripts/devnet-setup.ts`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]),
  );
}

// Whole-USDC integer -> 6dp minor units, integer math only (no floats, ever).
function usdcToMinor(whole: string): bigint {
  if (!/^\d+$/.test(whole)) {
    throw new Error(`amount must be a whole USDC integer, got: ${whole}`);
  }
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS);
}

async function main(): Promise<void> {
  const amountMinor = usdcToMinor(process.argv[2] ?? '5000');

  const stateFile = join(devnetDir, 'state.json');
  if (!existsSync(stateFile)) {
    throw new Error(`${stateFile} not found — run: npx tsx scripts/devnet-setup.ts`);
  }
  const { mint } = JSON.parse(readFileSync(stateFile, 'utf8')) as { mint: string };

  const payer = loadKeypair('keypair.json');
  const depositOwner = loadKeypair('deposit-owner.json');
  const mintPk = new PublicKey(mint);

  const sourceAta = getAssociatedTokenAddressSync(mintPk, payer.publicKey);
  const depositAta = getAssociatedTokenAddressSync(mintPk, depositOwner.publicKey);

  const connection = new Connection(RPC_URL, 'confirmed');

  console.log(`sending ${amountMinor} minor units (${process.argv[2] ?? '5000'} test-USDC)`);
  console.log(`  from ${sourceAta.toBase58()}`);
  console.log(`  to   ${depositAta.toBase58()} (deposit ATA)`);

  // transferChecked pins mint + decimals: the tx fails on-chain if either is
  // wrong, instead of silently moving the wrong token.
  const signature = await transferChecked(
    connection,
    payer, // fee payer
    sourceAta,
    mintPk,
    depositAta,
    payer, // owner of the source ATA
    amountMinor,
    USDC_DECIMALS,
  );

  console.log('\ndeposit sent.');
  console.log(`signature: ${signature}`);
  console.log(`explorer:  https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  console.log(`\nledger idempotency key: solana-devnet:${signature}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
