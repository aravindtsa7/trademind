import { OptionContract, OptionContractType } from '../../options/types';

export type SurfaceLeg = 'ATM_CE' | 'ATM_PE' | 'DOWN1_CE' | 'DOWN1_PE' | 'UP1_CE' | 'UP1_PE' | 'DOWN2_CE' | 'DOWN2_PE' | 'UP2_CE' | 'UP2_PE' | 'DOWN3_CE' | 'DOWN3_PE' | 'UP3_CE' | 'UP3_PE';
export interface SurfaceSelection { expiryDate: string; strikes: number[]; atmStrike: number; legs: Partial<Record<SurfaceLeg, OptionContract>>; missingLegs: SurfaceLeg[]; }
export interface SurfaceRequirement { instrumentKey: string; tradingDate: string; expiryDate: string; strike: number; optionType: OptionContractType; tradingSymbol: string; leg: SurfaceLeg; }

const legs: Array<[SurfaceLeg, number, OptionContractType]> = [
  ['ATM_CE', 0, 'CE'], ['ATM_PE', 0, 'PE'], ['DOWN1_CE', -1, 'CE'], ['DOWN1_PE', -1, 'PE'], ['UP1_CE', 1, 'CE'], ['UP1_PE', 1, 'PE'],
  ['DOWN2_CE', -2, 'CE'], ['DOWN2_PE', -2, 'PE'], ['UP2_CE', 2, 'CE'], ['UP2_PE', 2, 'PE'], ['DOWN3_CE', -3, 'CE'], ['DOWN3_PE', -3, 'PE'], ['UP3_CE', 3, 'CE'], ['UP3_PE', 3, 'PE'],
];

export function istExpiryDate(value: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }

export function selectNiftyOptionSurface(contracts: readonly OptionContract[], tradingDate: string, spot: number): SurfaceSelection {
  if (!Number.isFinite(spot) || spot <= 0) throw new Error('Surface selection requires positive finite spot.');
  const eligible = contracts.filter((contract) => istExpiryDate(contract.expiry) >= tradingDate);
  const expiryDate = [...new Set(eligible.map((contract) => istExpiryDate(contract.expiry)))].sort()[0];
  if (!expiryDate) throw new Error(`No non-expired option metadata for ${tradingDate}.`);
  const chain = eligible.filter((contract) => istExpiryDate(contract.expiry) === expiryDate);
  const seen = new Set<string>();
  chain.forEach((contract) => { const key = `${contract.strikePrice}|${contract.optionType}`; if (!contract.instrumentKey || !contract.tradingSymbol || !Number.isFinite(contract.strikePrice) || contract.strikePrice <= 0 || seen.has(key)) throw new Error(`Ambiguous or invalid option chain mapping ${key} for expiry ${expiryDate}.`); seen.add(key); });
  const strikes = [...new Set(chain.map((contract) => contract.strikePrice))].sort((a, b) => a - b);
  const atmStrike = [...strikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)[0];
  if (atmStrike === undefined) throw new Error(`No strikes for expiry ${expiryDate}.`);
  const index = strikes.indexOf(atmStrike); const output: Partial<Record<SurfaceLeg, OptionContract>> = {}; const missingLegs: SurfaceLeg[] = [];
  legs.forEach(([leg, offset, type]) => { const strike = strikes[index + offset]; const contract = strike === undefined ? undefined : chain.find((candidate) => candidate.strikePrice === strike && candidate.optionType === type); if (contract) output[leg] = contract; else missingLegs.push(leg); });
  return { expiryDate, strikes, atmStrike, legs: output, missingLegs };
}

export function deduplicateSurfaceRequirements(requirements: readonly SurfaceRequirement[]): SurfaceRequirement[] { return [...new Map(requirements.map((item) => [`${item.instrumentKey}|${item.tradingDate}`, item])).values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) || a.instrumentKey.localeCompare(b.instrumentKey)); }
export function regularSessionTimes(tradingDate: string): number[] { const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime(); return Array.from({ length: 375 }, (_, index) => start + index * 60_000); }
