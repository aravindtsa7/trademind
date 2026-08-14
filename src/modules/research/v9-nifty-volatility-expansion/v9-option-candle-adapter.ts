import { ExpiredOptionCandleDto } from '../../options/dto/upstox-expired-option-candle.dto';

export interface V9CachedOptionRow {
  instrumentKey: string;
  candleTime?: Date;
  timestamp?: Date;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
  openInterest?: unknown;
}

/** Strictly adapts persisted rows; it never changes market values or timestamps. */
export function adaptV9OptionCandles(rows: readonly V9CachedOptionRow[]): ExpiredOptionCandleDto[] {
  const output = rows.map((row, index) => {
    const candleTime = row.candleTime ?? row.timestamp;
    if (!(candleTime instanceof Date) || !Number.isFinite(candleTime.getTime())) throw new Error(`V9 option row ${index} has an invalid candle timestamp.`);
    const values = [row.open, row.high, row.low, row.close].map(Number);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`V9 option row ${index} has malformed OHLC.`);
    if (!row.instrumentKey) throw new Error(`V9 option row ${index} is missing instrumentKey.`);
    return { instrumentKey: row.instrumentKey, candleTime: new Date(candleTime.getTime()), open: values[0], high: values[1], low: values[2], close: values[3], volume: typeof row.volume === 'bigint' ? row.volume : BigInt(Number(row.volume ?? 0)), openInterest: row.openInterest === undefined || row.openInterest === null ? undefined : (typeof row.openInterest === 'bigint' ? row.openInterest : BigInt(Number(row.openInterest))) };
  });
  const ordered = [...output].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i - 1].candleTime.getTime() === ordered[i].candleTime.getTime()) throw new Error(`V9 option cache contains duplicate timestamp ${ordered[i].candleTime.toISOString()}.`);
  return ordered;
}
