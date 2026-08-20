import { isCurrentLiveGeneration } from '../../market-data/utils/live-generation';
import {
  planV12OptionUniverseRotation,
  V12UniverseContract,
} from './option-universe';

interface V12RotationRequest {
  readonly spot: number;
  readonly at: Date;
  readonly generationId: number;
  readonly token: number;
}

export interface V12UniverseRotationDependencies {
  readonly contracts: readonly V12UniverseContract[];
  readonly getActiveGenerationId: () => number | undefined;
  readonly getSubscribedOptionKeys: () => readonly string[];
  readonly subscribeMany: (instrumentKeys: readonly string[]) => Promise<void>;
  readonly unsubscribeMany: (instrumentKeys: readonly string[]) => void;
  readonly onSubscribeIntent?: (instrumentKey: string) => void;
  readonly onCommitted?: () => void;
}

export interface V12UniverseRotationSnapshot {
  readonly generationId?: number;
  readonly universeIdentity?: string;
  readonly atmStrike?: number;
  readonly optionKeys: ReadonlySet<string>;
}

/**
 * Serializes V12 option-universe subscription work while making every
 * post-await state mutation conditional on the generation and request token
 * that initiated it. Physical stale subscriptions are removed before the
 * newest generation request is processed.
 */
export class V12UniverseRotationCoordinator {
  private generationId?: number;
  private universeIdentity?: string;
  private atmStrike?: number;
  private optionKeys = new Set<string>();
  private nextToken = 0;
  private currentToken = 0;
  private inFlight?: V12RotationRequest;
  private pending?: V12RotationRequest;
  private drainPromise?: Promise<void>;

  constructor(private readonly dependencies: V12UniverseRotationDependencies) {}

  beginGeneration(generationId: unknown): boolean {
    const activeGenerationId = this.dependencies.getActiveGenerationId();
    if (!isCurrentLiveGeneration(generationId, activeGenerationId)) return false;
    if (this.generationId !== generationId) {
      this.generationId = generationId;
      this.universeIdentity = undefined;
      this.atmStrike = undefined;
      this.optionKeys.clear();
      this.pending = undefined;
      this.currentToken = ++this.nextToken;
    }
    return true;
  }

  request(spot: number, at: Date, generationId: unknown): Promise<void> {
    if (!this.beginGeneration(generationId)) return Promise.resolve();
    const liveGenerationId = generationId as number;
    // Preserve the prior same-generation coalescing behavior. A newer socket
    // generation, however, must supersede rather than be dropped behind G1.
    if (this.inFlight?.generationId === liveGenerationId) return this.drainPromise ?? Promise.resolve();
    const request: V12RotationRequest = {
      spot,
      at: new Date(at.getTime()),
      generationId: liveGenerationId,
      token: ++this.nextToken,
    };
    this.currentToken = request.token;
    this.pending = request;
    if (!this.drainPromise) {
      const drain = this.drain();
      this.drainPromise = drain.finally(() => { this.drainPromise = undefined; });
    }
    return this.drainPromise;
  }

  snapshot(): V12UniverseRotationSnapshot {
    return Object.freeze({
      generationId: this.generationId,
      universeIdentity: this.universeIdentity,
      atmStrike: this.atmStrike,
      optionKeys: new Set(this.optionKeys),
    });
  }

  hasInstrument(instrumentKey: string): boolean { return this.optionKeys.has(instrumentKey); }
  getAtmStrike(): number | undefined { return this.atmStrike; }

  private async drain(): Promise<void> {
    while (this.pending) {
      const request = this.pending;
      this.pending = undefined;
      this.inFlight = request;
      try {
        await this.execute(request);
      } finally {
        if (this.inFlight === request) this.inFlight = undefined;
      }
    }
  }

  private async execute(request: V12RotationRequest): Promise<void> {
    if (!this.isCurrent(request)) return;
    const subscribedOptionKeys = new Set(this.dependencies.getSubscribedOptionKeys());
    const plan = planV12OptionUniverseRotation(
      this.dependencies.contracts,
      request.spot,
      request.at,
      this.universeIdentity,
      subscribedOptionKeys,
    );
    if (!plan.changed || !plan.universe) return;

    if (plan.addedInstrumentKeys.length) {
      plan.addedInstrumentKeys.forEach((instrumentKey) => this.dependencies.onSubscribeIntent?.(instrumentKey));
      try {
        await this.dependencies.subscribeMany(plan.addedInstrumentKeys);
      } catch (error) {
        if (!this.isCurrent(request)) {
          this.dependencies.unsubscribeMany(plan.addedInstrumentKeys);
          return;
        }
        throw error;
      }
    }

    if (!this.isCurrent(request)) {
      // SubscriptionManager records intent before its await. Remove only the
      // additions made by this stale plan; the queued current request will then
      // establish the authoritative subscription delta.
      this.dependencies.unsubscribeMany(plan.addedInstrumentKeys);
      return;
    }

    if (plan.removedInstrumentKeys.length) this.dependencies.unsubscribeMany(plan.removedInstrumentKeys);
    this.optionKeys = new Set(plan.nextInstrumentKeys);
    this.atmStrike = plan.universe.atmStrike;
    this.universeIdentity = plan.universe.identity;
    this.dependencies.onCommitted?.();
  }

  private isCurrent(request: V12RotationRequest): boolean {
    return request.token === this.currentToken
      && request.generationId === this.generationId
      && isCurrentLiveGeneration(request.generationId, this.dependencies.getActiveGenerationId());
  }
}
