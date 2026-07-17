import { AcmePayProvider } from './acmepay.js';
import { LegacyBankProvider } from './legacybank.js';
import { PolygonUsdtProvider, type PolygonUsdtOptions } from './polygon-usdt.js';
import type { PayoutProvider } from './provider.js';

// Config-driven provider registry (DESIGN §7.1). Routing refers to providers
// by NAME only (route_actions.provider); the registry maps names to adapters.
//
// "Provider #3 is a config change": adding FastACH Inc. means (a) one entry in
// the config array below reusing an existing adapter kind, or (b) a new
// ~50-line adapter implementing the 4-method port plus its config entry.
// The ledger core, the routing engine, settlement, and the HTTP layer never
// change — they never knew provider vocabularies, only canonical states.
// (In production each entry would also carry credentials by ENV REFERENCE —
// never inline — per ADR-021; the mocks need none.)

export type AdapterKind = 'acmepay' | 'legacybank' | 'polygon-usdt';

export interface ProviderConfig {
  name: string; // registry key, referenced by route_actions.provider
  adapter: AdapterKind; // which adapter implementation to instantiate
  options?: PolygonUsdtOptions; // adapter-specific knobs (only the simulator has any)
}

const ADAPTER_FACTORIES: Record<AdapterKind, (config: ProviderConfig) => PayoutProvider> = {
  acmepay: (config) => new AcmePayProvider(config.name),
  legacybank: (config) => new LegacyBankProvider(config.name),
  'polygon-usdt': (config) => new PolygonUsdtProvider(config.name, config.options ?? {}),
};

export const defaultProviderConfigs: ProviderConfig[] = [
  { name: 'acmepay', adapter: 'acmepay' },
  { name: 'legacybank', adapter: 'legacybank' },
  { name: 'polygon-usdt', adapter: 'polygon-usdt' },
];

export class ProviderRegistry {
  private readonly providers = new Map<string, PayoutProvider>();

  register(provider: PayoutProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`provider ${provider.name} is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): PayoutProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`unknown payout provider: ${name}`);
    return provider;
  }

  maybeGet(name: string): PayoutProvider | undefined {
    return this.providers.get(name);
  }

  list(): PayoutProvider[] {
    return [...this.providers.values()];
  }
}

export function buildRegistry(
  configs: ProviderConfig[] = defaultProviderConfigs,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const config of configs) {
    registry.register(ADAPTER_FACTORIES[config.adapter](config));
  }
  return registry;
}

// Process-wide default. Mock providers keep in-memory payout state, so the
// dispatcher and the mock settlement endpoints must share ONE set of
// instances; tests build their own isolated registries via buildRegistry().
export const defaultRegistry: ProviderRegistry = buildRegistry();
