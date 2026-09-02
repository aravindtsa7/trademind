export interface InstrumentDefinition {
  readonly instrumentKey: string;
  readonly label: string;
}

/**
 * Generic registry of underlying instruments the shared gateway is aware of. Deliberately
 * carries no strategy-alignment, source-horizon, candle-construction, or recovery state -- those
 * remain owned per consumer (see SharedMarketDataGateway's class doc). This registry exists so
 * the gateway's architecture is never hardcoded around exactly one underlying: registering a
 * second index (e.g. BANKNIFTY) later is a register() call here, not a rewrite of the gateway.
 *
 * Only NIFTY is registered by createDefaultInstrumentRegistry() today. This class never
 * fabricates an instrument key for an index that is not actually enabled for trading.
 */
export class InstrumentRegistry {
  private readonly instruments = new Map<string, InstrumentDefinition>();

  register(definition: InstrumentDefinition): void {
    const instrumentKey = definition.instrumentKey.trim();
    if (!instrumentKey) throw new Error('InstrumentRegistry: instrumentKey must be a non-empty string.');
    this.instruments.set(instrumentKey, { ...definition, instrumentKey });
  }

  isRegistered(instrumentKey: string): boolean {
    return this.instruments.has(instrumentKey);
  }

  get(instrumentKey: string): InstrumentDefinition | undefined {
    return this.instruments.get(instrumentKey);
  }

  list(): readonly InstrumentDefinition[] {
    return Array.from(this.instruments.values());
  }
}

/** Canonical NIFTY 50 index instrument key used by every current live strategy (V2/V4/V8). */
export const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';

/** Today's enabled universe: NIFTY only. BANKNIFTY/FINNIFTY are intentionally not registered. */
export function createDefaultInstrumentRegistry(): InstrumentRegistry {
  const registry = new InstrumentRegistry();
  registry.register({ instrumentKey: niftyInstrumentKey, label: 'NIFTY 50' });
  return registry;
}
