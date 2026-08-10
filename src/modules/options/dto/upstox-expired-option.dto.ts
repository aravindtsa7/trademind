export interface UpstoxExpiredInstrumentsApiResponseDto<TData> {
  status: string;
  data: TData;
}

export interface UpstoxExpiredOptionContractApiDto {
  instrument_key: string;
  trading_symbol: string;
  underlying_symbol: string;
  strike_price: number;
  expiry: string;
  instrument_type: string;
  exchange: string;
  segment: string;
  lot_size?: number;
}
