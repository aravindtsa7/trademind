import { OptionContract } from '../../options/types/option-contract.types';

export interface V12UniverseContract extends OptionContract { readonly optionType: 'CE' | 'PE'; }
export interface V12OptionUniverse { expiry: Date; atmStrike: number; contracts: readonly V12UniverseContract[]; identity: string; missingLegs: string[]; }
export interface V12OptionUniverseRotation {
  readonly changed: boolean;
  readonly universe?: V12OptionUniverse;
  readonly addedInstrumentKeys: readonly string[];
  readonly removedInstrumentKeys: readonly string[];
  readonly nextInstrumentKeys: ReadonlySet<string>;
}
const dateOnly = (date: Date): string => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);

/** Active instrument metadata uses both NIFTY and NIFTY 50 aliases. */
export function isV12NiftyUnderlying(value: string | null | undefined): boolean {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized === 'NIFTY' || normalized === 'NIFTY50';
}

/**
 * Computes a deterministic subscription delta. The caller owns subscription
 * I/O, which keeps selection testable and prevents a second websocket path.
 */
export function planV12OptionUniverseRotation(
  contracts: readonly V12UniverseContract[],
  spot: number,
  at: Date,
  currentIdentity: string | undefined,
  currentInstrumentKeys: ReadonlySet<string>,
): V12OptionUniverseRotation {
  const universe = resolveV12OptionUniverse(contracts, spot, at);
  if (!universe || universe.identity === currentIdentity) {
    return { changed: false, addedInstrumentKeys: [], removedInstrumentKeys: [], nextInstrumentKeys: new Set(currentInstrumentKeys) };
  }
  const nextInstrumentKeys = new Set(universe.contracts.map((contract) => contract.instrumentKey));
  return {
    changed: true,
    universe,
    addedInstrumentKeys: [...nextInstrumentKeys].filter((key) => !currentInstrumentKeys.has(key)),
    removedInstrumentKeys: [...currentInstrumentKeys].filter((key) => !nextInstrumentKeys.has(key)),
    nextInstrumentKeys,
  };
}

/** Ignore an event from a retired websocket generation before it reaches V12 storage. */
export function isV12CurrentGeneration(eventGenerationId: number | undefined, activeGenerationId: number): boolean {
  return eventGenerationId === undefined || eventGenerationId === activeGenerationId;
}
/** Same expiry/nearest-strike ordering as the canonical selector; the adjacent strikes are metadata ladder positions. */
export function resolveV12OptionUniverse(contracts: readonly V12UniverseContract[], spot: number, at: Date): V12OptionUniverse | null {
  const sessionDate = dateOnly(at); const eligible = contracts.filter((contract) => dateOnly(contract.expiry) >= sessionDate && Number.isFinite(contract.strikePrice) && contract.strikePrice > 0);
  if (!eligible.length || !Number.isFinite(spot) || spot <= 0) return null;
  const expiryText = eligible.map((contract) => dateOnly(contract.expiry)).sort()[0]; const expiryContracts = eligible.filter((contract) => dateOnly(contract.expiry) === expiryText);
  const strikes = [...new Set(expiryContracts.map((contract) => contract.strikePrice))].sort((a,b)=>a-b);
  const atm = [...strikes].sort((a,b)=>Math.abs(a-spot)-Math.abs(b-spot)||a-b)[0]; const index = strikes.indexOf(atm); const wanted = [strikes[index-1], atm, strikes[index+1]].filter((strike): strike is number=>strike!==undefined);
  const selected: V12UniverseContract[]=[]; const missingLegs:string[]=[];
  for (const strike of wanted) for (const optionType of ['CE','PE'] as const) { const contract=expiryContracts.filter((item)=>item.strikePrice===strike&&item.optionType===optionType).sort((a,b)=>a.instrumentKey.localeCompare(b.instrumentKey))[0]; if(contract) selected.push(contract); else missingLegs.push(`${strike}_${optionType}`); }
  const expiry=expiryContracts[0].expiry; const identity=[expiry.toISOString(), ...selected.map((c)=>c.instrumentKey).sort()].join('|');
  return {expiry,atmStrike:atm,contracts:selected,identity,missingLegs};
}
