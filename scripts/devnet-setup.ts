// devnet-setup.ts — one-shot Solana devnet provisioning for the E2E crypto leg.
//
//   Run:   npx tsx scripts/devnet-setup.ts
//   (idempotent: keypairs and the mint are cached in .devnet/ — gitignored —
//    so re-running reuses them instead of re-provisioning)
//
// What it does, fully automated (RPC only, no faucet captcha):
//   1. Generates/loads two keypairs in .devnet/: `payer` (the client's sending
//      wallet, also mint authority) and `deposit-owner` (Kira's deposit wallet).
//   2. Airdrops SOL to the payer via requestAirdrop, with retry/backoff —
//      devnet rate-limits aggressively.
//   3. Creates a 6-decimal "test USDC" SPL mint. This is a VENDOR ABSTRACTION
//      AS CONFIG (DESIGN §7.1): to watch Circle's official devnet USDC instead,
//      just set SOLANA_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU —
//      zero code changes; the watcher only knows "the configured mint".
//      (We mint our own because Circle's faucet needs a browser + captcha,
//      which kills unattended setup.)
//   4. Creates the associated token accounts (ATAs) for both wallets and mints
//      5,000 test-USDC (= 5_000_000_000 at 6dp) to the payer.
//   5. Prints the env values ready to paste into .env.
//
// Then: npx tsx scripts/devnet-deposit.ts   (sends the 5,000 USDC deposit)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_DECIMALS = 6;
const SEED_AMOUNT_MINOR = 5_000_000_000n; // 5,000 test-USDC at 6dp

const here = dirname(fileURLToPath(import.meta.url));
const devnetDir = join(here, '..', '.devnet');
const stateFile = join(devnetDir, 'state.json');

function loadOrCreateKeypair(file: string): Keypair {
  const path = join(devnetDir, file);
  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`generated ${file}: ${kp.publicKey.toBase58()}`);
  return kp;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Devnet airdrops rate-limit hard; retry with exponential backoff and skip
// entirely if the payer already has enough SOL from a previous run.
async function ensureSol(connection: Connection, pubkey: PublicKey): Promise<void> {
  const balance = await connection.getBalance(pubkey);
  if (balance >= 0.5 * LAMPORTS_PER_SOL) {
    console.log(`payer already has ${balance / LAMPORTS_PER_SOL} SOL — skipping airdrop`);
    return;
  }
  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    try {
      console.log(`requesting 1 SOL airdrop (attempt ${i + 1}/${attempts})...`);
      const sig = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
      console.log(`airdrop confirmed: ${sig}`);
      return;
    } catch (err) {
      const backoff = 2_000 * 2 ** i;
      console.warn(`airdrop failed (${(err as Error).message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  // The RPC faucet has a daily per-IP limit and periodically runs dry. The
  // script stays unattended-friendly: fund the printed payer address once via
  // the web faucet and re-run — the balance check above skips the airdrop.
  throw new Error(
    `airdrop kept failing — devnet faucet is rate-limited or dry.\n` +
      `  Fund the payer manually (needs ~0.5 SOL) and re-run this script:\n` +
      `    payer: ${pubkey.toBase58()}\n` +
      `    faucet: https://faucet.solana.com  (or: solana airdrop 1 ${pubkey.toBase58()} -u devnet)`,
  );
}

interface DevnetState {
  mint: string;
}

async function main(): Promise<void> {
  mkdirSync(devnetDir, { recursive: true });
  const connection = new Connection(RPC_URL, 'confirmed');

  const payer = loadOrCreateKeypair('keypair.json');
  const depositOwner = loadOrCreateKeypair('deposit-owner.json');

  await ensureSol(connection, payer.publicKey);

  // Reuse the cached mint when it still exists on-chain (devnet resets happen).
  let mint: PublicKey | null = null;
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as DevnetState;
    try {
      const candidate = new PublicKey(state.mint);
      await getMint(connection, candidate);
      mint = candidate;
      console.log(`reusing existing test-USDC mint: ${mint.toBase58()}`);
    } catch {
      console.warn('cached mint not found on-chain (devnet reset?) — creating a new one');
    }
  }
  if (!mint) {
    console.log('creating 6dp test-USDC mint...');
    mint = await createMint(
      connection,
      payer, // fee payer
      payer.publicKey, // mint authority
      null, // no freeze authority
      USDC_DECIMALS,
    );
    writeFileSync(stateFile, JSON.stringify({ mint: mint.toBase58() } satisfies DevnetState, null, 2));
    console.log(`mint created: ${mint.toBase58()}`);
  }

  console.log('ensuring associated token accounts...');
  const payerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const depositAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    depositOwner.publicKey,
  );

  if (payerAta.amount < SEED_AMOUNT_MINOR) {
    console.log(`minting ${SEED_AMOUNT_MINOR} minor units (5,000 test-USDC) to the payer...`);
    await mintTo(connection, payer, mint, payerAta.address, payer, SEED_AMOUNT_MINOR);
  } else {
    console.log(`payer ATA already holds ${payerAta.amount} minor units — skipping mint`);
  }

  console.log('\n=== devnet ready — paste into .env ===============================');
  console.log(`SOLANA_RPC_URL=${RPC_URL}`);
  console.log(`SOLANA_USDC_MINT=${mint.toBase58()}`);
  console.log(`SOLANA_DEPOSIT_OWNER=${depositOwner.publicKey.toBase58()}`);
  console.log(`ENABLE_CHAIN_WATCHER=true`);
  console.log('==================================================================');
  console.log(`payer wallet:      ${payer.publicKey.toBase58()}`);
  console.log(`payer ATA:         ${payerAta.address.toBase58()}`);
  console.log(`deposit ATA:       ${depositAta.address.toBase58()}  <- the watched address`);
  console.log('\nnext: npx tsx scripts/devnet-deposit.ts   # sends the 5,000 USDC deposit');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
