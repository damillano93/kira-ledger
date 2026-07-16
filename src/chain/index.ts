// Public surface of the chain leg. The integration wave wires this into
// server.ts: start only when config.ENABLE_CHAIN_WATCHER is true, e.g.
//
//   import { startChainWatcher } from './chain/index.js';
//   if (config.ENABLE_CHAIN_WATCHER) {
//     const watcher = startChainWatcher();
//     app.addHook('onClose', async () => watcher.stop());
//   }
//
// The routing module registers its trigger via setOnOfframpConfirmed(cb).

export {
  CHAIN,
  pollOnce,
  setOnOfframpConfirmed,
  startChainWatcher,
  type ChainWatcherHandle,
  type OfframpConfirmedEvent,
  type WatcherOptions,
} from './watcher.js';
export { createSolanaRpc, deriveDepositAta, type ChainRpc } from './rpc.js';
export { parseSplDeposit, type ParsedTransactionView, type SplDeposit } from './parser.js';
