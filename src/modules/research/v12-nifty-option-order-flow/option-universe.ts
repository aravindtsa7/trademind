import { OptionContract } from '../../options/types/option-contract.types';

export interface V12UniverseContract extends OptionContract { readonly optionType: 'CE' | 'PE'; }
export interface V12OptionUniverse { expiry: Date; atmStrike: number; contracts: readonly V12UniverseContract[]; identity: string; missingLegs: string[]; }
const dateOnly = (date: Date): string => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
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
