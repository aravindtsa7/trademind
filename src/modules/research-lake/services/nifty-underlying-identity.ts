/**
 * Shared NIFTY-underlying identity constants. Extracted from
 * `nifty-underlying-acquisition.service.ts` (task B-F2-CAL-2) so that file
 * and `nifty-underlying-ingestion-planner.service.ts` can both depend on
 * these values without an import cycle: CAL-2 wires the planner INTO the
 * acquisition service, and the planner already depended on this constant
 * from the acquisition service file. `nifty-underlying-acquisition.service.ts`
 * re-exports both names so every existing import site is unaffected.
 */
export const NIFTY_INDEX_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
export const NIFTY_UNDERLYING_TIMEFRAME = '1minute';
