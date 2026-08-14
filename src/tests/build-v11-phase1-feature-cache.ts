import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import { OptionContract } from '../modules/options/types';
import { selectNiftyOptionSurface } from '../modules/research/v11-nifty-iv-skew/option-surface';
import { solveEuropeanImpliedVolatility } from '../modules/research/v11-nifty-iv-skew/implied-volatility';
import { featureDelta, V11DeltaPoint } from '../modules/research/v11-nifty-iv-skew/surface-signal';
const DIR = resolve(process.cwd(), 'artifacts', 'v11-nifty-iv-skew'),
  NIFTY = 'NSE_INDEX|Nifty 50';
const date = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
type Row = any;
type Cache = { version: string; rows: any[] };
const partFile = (tradingDate: string) => resolve(DIR, 'phase-1-feature-cache-parts', `${tradingDate}.json`);
async function run() {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw Error('Requires RESEARCH_LOCAL_ONLY=true.');
  const tradingDate = process.env.V11_FEATURE_DATE;
  if (!tradingDate) throw Error('Set V11_FEATURE_DATE.');
  const manifest = JSON.parse(
    readFileSync(resolve(DIR, 'phase-0-surface-cache-manifest.json'), 'utf8'),
  );
  const req = manifest.required.filter((x: any) => x.tradingDate === tradingDate);
  if (!req.length) throw Error(`No local V11 manifest contracts for ${tradingDate}.`);
  const contracts = [
    ...new Map(
      req.map((x: any) => [
        x.instrumentKey,
        {
          instrumentKey: x.instrumentKey,
          tradingSymbol: x.tradingSymbol,
          underlying: 'Nifty 50',
          strikePrice: x.strike,
          optionType: x.optionType,
          expiry: new Date(`${x.expiryDate}T00:00:00+05:30`),
          exchange: 'NSE',
          segment: 'NSE_FO',
        },
      ]),
    ).values(),
  ] as OptionContract[];
  const optionRows = await new HistoricalOptionCandleRepository().findByInstrumentDateSessions(
    req,
    '1minute',
  );
  const option = new Map<string, Row>();
  optionRows.forEach((x: any) =>
    option.set(`${x.instrumentKey}|${new Date(x.candleTime).getTime()}`, x),
  );
  const underlying = (
    await new HistoricalCandleRepository().findByInstrumentAndTimeframe(NIFTY, '1minute')
  )
    .filter((x: any) => date(x.candleTime) === tradingDate)
    .sort((a: any, b: any) => new Date(a.candleTime).getTime() - new Date(b.candleTime).getTime());
  if (existsSync(partFile(tradingDate))) {
    console.log('V11_FEATURE_DATE_ALREADY_CACHED', tradingDate);
    return;
  }
  const out: any[] = [];
  const atrs: number[] = [];
  const points: { 1?: V11DeltaPoint & { atm: number }; 2?: V11DeltaPoint & { atm: number } }[] = [];
  let missing = 0,
    ivFailures = 0;
  for (let i = 0; i < underlying.length; i++) {
    const u = underlying[i],
      ts = new Date(u.candleTime),
      spot = Number(u.close);
    const tr = i
      ? Math.max(
          Number(u.high) - Number(u.low),
          Math.abs(Number(u.high) - Number(underlying[i - 1].close)),
          Math.abs(Number(u.low) - Number(underlying[i - 1].close)),
        )
      : Number(u.high) - Number(u.low);
    atrs.push(tr);
    const atr = atrs.length >= 14 ? atrs.slice(-14).reduce((a, b) => a + b, 0) / 14 : null;
    let s: any;
    try {
      s = selectNiftyOptionSurface(contracts, tradingDate, spot);
    } catch {
      missing++;
      continue;
    }
    const iv = (leg: string) => {
      const c = s.legs[leg],
        r = c && option.get(`${c.instrumentKey}|${ts.getTime()}`);
      if (!c || !r || Number(r.close) <= 0) return null;
      const q = solveEuropeanImpliedVolatility({
        optionType: c.optionType,
        spot,
        strike: c.strikePrice,
        premium: Number(r.close),
        timeToExpiryYears:
          (new Date(`${s.expiryDate}T15:30:00+05:30`).getTime() - ts.getTime()) / (365 * 86400000),
        riskFreeRate: 0.06,
        dividendYield: 0,
      });
      if (!q.converged || q.impliedVolatility === null) {
        ivFailures++;
        return null;
      }
      return q.impliedVolatility;
    };
    const ace = iv('ATM_CE'),
      ape = iv('ATM_PE');
    if (ace === null || ape === null) {
      missing++;
      continue;
    }
    const atm = (ace + ape) / 2;
    const row: any = {
      tradingDate,
      timestamp: ts.toISOString(),
      expiry: s.expiryDate,
      spot,
      atmStrike: s.atmStrike,
      atmCeIv: ace,
      atmPeIv: ape,
      atmIv: atm,
      bullish1m:
        Number(u.close) > Number(u.open) &&
        atr !== null &&
        Math.abs(Number(u.close) - Number(u.open)) >= 0.25 * atr,
      bearish1m:
        Number(u.close) < Number(u.open) &&
        atr !== null &&
        Math.abs(Number(u.close) - Number(u.open)) >= 0.25 * atr,
      missingSurface: false,
      ivFailure: false,
    };
    for (const w of [1, 2]) {
      const ce = iv(`UP${w}_CE`),
        pe = iv(`DOWN${w}_PE`);
      if (ce === null || pe === null) {
        row[`missing${w}`] = true;
        continue;
      }
      const p: any = {
        timestamp: ts,
        expiry: s.expiryDate,
        atmStrike: s.atmStrike,
        ceWingStrike: s.legs[`UP${w}_CE`].strikePrice,
        peWingStrike: s.legs[`DOWN${w}_PE`].strikePrice,
        upsideSkew: ce - atm,
        downsideSkew: pe - atm,
        riskReversal: ce - pe,
        atm,
      };
      points[i] ??= {};
      points[i][w as 1 | 2] = p;
      row[`minus${w}Strike`] = p.peWingStrike;
      row[`plus${w}Strike`] = p.ceWingStrike;
      row[`downsideSkew${w}`] = p.downsideSkew;
      row[`upsideSkew${w}`] = p.upsideSkew;
      row[`riskReversal${w}`] = p.riskReversal;
      for (const h of [1, 3, 5]) {
        const prior = points[i - h]?.[w as 1 | 2];
        const up = prior && featureDelta(p, prior, 'upsideSkew'),
          down = prior && featureDelta(p, prior, 'downsideSkew'),
          rr = prior && featureDelta(p, prior, 'riskReversal');
        row[`up${w}h${h}`] = up ?? null;
        row[`down${w}h${h}`] = down ?? null;
        row[`rr${w}h${h}`] = rr ?? null;
        row[`roll${w}h${h}`] = prior !== undefined && up === null;
      }
    }
    out.push(row);
  }
  mkdirSync(resolve(DIR, 'phase-1-feature-cache-parts'), { recursive: true });
  writeFileSync(
    partFile(tradingDate),
    JSON.stringify(
      {
        version: 'v11-phase1-feature-semantics-v1', rows: out,
        semantics:
          'completed local NIFTY/option 1m candles; exact same expiry/ATM/wings required for deltas; no forward fill; 6%/0%/15:30IST',
        latestBuild: { tradingDate, rows: out.length, missingSurface: missing, ivFailures },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      tradingDate,
      rows: out.length,
      missingSurface: missing,
      ivFailures,
      optionDownloads: 0,
      cacheWrites: 0,
    }),
  );
}
void run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
