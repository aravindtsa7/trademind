import { HistoricalOptionContractIdentity } from '../domain';
import { HistoricalProviderCapability, HistoricalProviderId } from './historical-provider-capability.types';

export interface HistoricalExpiryDiscoveryRequest {
  readonly underlyingKey: string;
  readonly asOfTradingDate: string;
}

export interface HistoricalContractDiscoveryRequest {
  readonly underlyingKey: string;
  readonly expiry: Date;
}

/**
 * Provider-neutral abstraction for discovering historical/expired option
 * contract metadata. Expiry/contract discovery is explicitly optional --
 * `getCapability()` tells a caller whether this provider supports it at
 * all, rather than every provider being forced to implement it. No provider
 * implements this in B-F1.
 */
export interface HistoricalContractProvider {
  readonly providerId: HistoricalProviderId;
  getCapability(): HistoricalProviderCapability;
  discoverExpiries(request: HistoricalExpiryDiscoveryRequest): Promise<readonly Date[]>;
  discoverContracts(
    request: HistoricalContractDiscoveryRequest
  ): Promise<readonly HistoricalOptionContractIdentity[]>;
}
