/**
 * Provider-neutral historical research asset taxonomy. Scoped to the two
 * asset kinds the Historical Research Lake needs to represent now; adding a
 * new underlying/instrument family later is an additive enum change here.
 */
export enum HistoricalAssetType {
  NIFTY_INDEX = 'NIFTY_INDEX',
  NIFTY_OPTION = 'NIFTY_OPTION',
}

export enum HistoricalOptionType {
  CE = 'CE',
  PE = 'PE',
}

/**
 * How much of an option chain a historical dataset is expected to cover for
 * a given underlying/expiry: only the strikes a strategy actually trades
 * (`STRATEGY_UNIVERSE`) versus every listed strike (`FULL_CHAIN`). This is a
 * dataset-acquisition-scope concept for the future downloader/manifest work
 * (B-F2+); B-F1 defines the type only, nothing in this module consumes it
 * yet.
 */
export enum DatasetCoverageMode {
  STRATEGY_UNIVERSE = 'STRATEGY_UNIVERSE',
  FULL_CHAIN = 'FULL_CHAIN',
}
