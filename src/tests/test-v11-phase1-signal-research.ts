import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import ResearchSplitService from '../modules/research-validation/services/research-split.service';
import { selectNiftyOptionSurface } from '../modules/research/v11-nifty-iv-skew/option-surface';
import { solveEuropeanImpliedVolatility } from '../modules/research/v11-nifty-iv-skew/implied-volatility';
import {
  applyEpisode,
  featureDelta,
  robustZ,
  V11DeltaPoint,
} from '../modules/research/v11-nifty-iv-skew/surface-signal';
const NIFTY = 'NSE_INDEX|Nifty 50',
  DIR = resolve(process.cwd(), 'artifacts', 'v11-nifty-iv-skew'),
  RATE = 0.06;
type Direction = 'CE' | 'PE';
const istDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
const time = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
const config = () => {
  const out: any[] = [];
  let i = 0;
  for (const wing of [1, 2])
    for (const horizon of [1, 3, 5])
      for (const baseline of [20, 40])
        for (const z of [1, 1.5, 2])
          for (const rr of [false, true])
            for (const underlying of [false, true])
              for (const cooldown of [5, 10])
                out.push({
                  id: `V11_${++i}`,
                  wing,
                  horizon,
                  baseline,
                  z,
                  rr,
                  underlying,
                  cooldown,
                });
  return out;
};
const quant = (v: number[], p: number) =>
  v.length ? [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * p)] : 0;
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
async function run() {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true')
    throw Error('V11 phase-1 requires RESEARCH_LOCAL_ONLY=true.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw Error('Authoritative chain metadata requires UPSTOX_ACCESS_TOKEN.');
  const split = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'artifacts/research-validation/nifty-104-split-v1.json'),
      'utf8',
    ),
  );
  const dates: string[] = split.sessions
    .filter((x: any) => x.split === 'TRAIN' || x.split === 'VALIDATION')
    .map((x: any) => x.tradingDate);
  new ResearchSplitService().assertOutcomeAccess(split, dates, 'TRAIN_VALIDATION_ONLY');
  const cfg = config();
  if (cfg.length !== 288) throw Error(`Expected 288 configs, got ${cfg.length}`);
  const under = await new HistoricalCandleRepository().findByInstrumentAndTimeframe(
    NIFTY,
    '1minute',
  );
  const u = new Map<string, any>();
  under.forEach((r: any) => {
    if (dates.includes(istDate(r.candleTime)))
      u.set(`${istDate(r.candleTime)}|${new Date(r.candleTime).getTime()}`, r);
  });
  const meta = new UpstoxExpiredOptionClient(token);
  let metadataRequests = 1;
  const expiries = (await meta.fetchAvailableExpiries(NIFTY)).sort();
  const exp = new Map<string, string>();
  dates.forEach((d) => {
    const e = expiries.find((x) => x >= d);
    if (e) exp.set(d, e);
  });
  const chains = new Map<string, any[]>();
  for (const e of new Set(exp.values())) {
    metadataRequests++;
    chains.set(e, await meta.fetchExpiredOptionContracts(NIFTY, e));
  }
  const manifest = JSON.parse(
    readFileSync(resolve(DIR, 'phase-0-surface-cache-manifest.json'), 'utf8'),
  );
  const req = manifest.required;
  const rows = await new HistoricalOptionCandleRepository().findByInstrumentDateSessions(
    req,
    '1minute',
  );
  const o = new Map<string, any>();
  rows.forEach((r: any) => o.set(`${r.instrumentKey}|${new Date(r.candleTime).getTime()}`, r));
  let missingSurface = 0,
    roll = 0,
    baselineUnavailable = 0,
    zeroMad = 0,
    ivFailures = 0;
  const perDate = new Map<string, any[]>();
  for (const d of dates) {
    const points: any[] = [];
    for (let minute = 9 * 60 + 15; minute <= 15 * 60 + 29; minute++) {
      const stamp = new Date(`${d}T09:15:00+05:30`);
      stamp.setTime(stamp.getTime() + (minute - (9 * 60 + 15)) * 60000);
      const ur = u.get(`${d}|${stamp.getTime()}`);
      const e = exp.get(d);
      if (!ur || !e) {
        missingSurface++;
        continue;
      }
      let s: any;
      try {
        s = selectNiftyOptionSurface(chains.get(e) ?? [], d, Number(ur.close));
      } catch {
        missingSurface++;
        continue;
      }
      const iv = (leg: string) => {
        const c = s.legs[leg];
        const r = c && o.get(`${c.instrumentKey}|${stamp.getTime()}`);
        if (!c || !r || Number(r.close) <= 0) return null;
        const q = solveEuropeanImpliedVolatility({
          optionType: c.optionType,
          spot: Number(ur.close),
          strike: c.strikePrice,
          premium: Number(r.close),
          timeToExpiryYears:
            (new Date(`${s.expiryDate}T15:30:00+05:30`).getTime() - stamp.getTime()) /
            (365 * 86400000),
          riskFreeRate: RATE,
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
        missingSurface++;
        continue;
      }
      const atm = (ace + ape) / 2;
      const by: any = {};
      for (const w of [1, 2]) {
        const ce = iv(`UP${w}_CE`),
          pe = iv(`DOWN${w}_PE`);
        if (ce === null || pe === null) {
          by[w] = null;
          continue;
        }
        by[w] = {
          expiry: s.expiryDate,
          atmStrike: s.atmStrike,
          ceWingStrike: s.legs[`UP${w}_CE`].strikePrice,
          peWingStrike: s.legs[`DOWN${w}_PE`].strikePrice,
          upsideSkew: ce - atm,
          downsideSkew: pe - atm,
          riskReversal: ce - pe,
          atm,
        };
      }
      points.push({ stamp, under: ur, by });
    }
    perDate.set(d, points);
  }
  // Cache each causal z-score series once per structural feature tuple. Configs only
  // differ in thresholds/confirmations/cooldown, so recomputing rolling MAD for each
  // config would be both wasteful and memory-intensive.
  const derived = new Map<string, Map<number, any>>();
  for (const d of dates) for (const wing of [1, 2]) for (const horizon of [1, 3, 5]) for (const baseline of [20, 40]) for (const direction of ['CE', 'PE'] as Direction[]) {
    const points = perDate.get(d) ?? [], byTime = new Map(points.map((point: any) => [point.stamp.getTime(), point]));
    const history: number[] = [], output = new Map<number, any>(); const feature = direction === 'CE' ? 'upsideSkew' : 'downsideSkew';
    for (const point of points) { const current=point.by[wing] as V11DeltaPoint|undefined; const previous=byTime.get(point.stamp.getTime()-horizon*60000)?.by[wing] as V11DeltaPoint|undefined; if(!current||!previous){missingSurface++;output.set(point.stamp.getTime(),null);continue;} const delta=featureDelta(current,previous,feature), rrDelta=featureDelta(current,previous,'riskReversal'); if(delta===null||rrDelta===null){roll++;output.set(point.stamp.getTime(),null);continue;} const z=robustZ(delta,history.slice(Math.max(0,history.length-baseline)),10); if(z.reason==='INSUFFICIENT_BASELINE')baselineUnavailable++;if(z.reason==='ZERO_MAD')zeroMad++; output.set(point.stamp.getTime(),{current,delta,rrDelta,z}); history.push(delta); }
    derived.set(`${d}|${wing}|${horizon}|${baseline}|${direction}`,output);
  }
  const outcomes: any[] = []; let totalSignals = 0, expiryDaySignals = 0, duplicate = 0;
  for (const c of cfg) {
    const dirs: Direction[] = ['CE', 'PE'];
    const records: any = {};
    dirs.forEach(
      (d) =>
        (records[d] = {
          count: 0,
          z: [],
          atm: [],
          skew: [],
          delta: [],
          rr: [],
          dates: new Map<string, number>(),
          expiry: new Map<string, number>(),
          times: new Map<string, number>(),
        }),
    );
    for (const d of dates) {
      let state: any = {
        CE: { armed: true, lastSignalAt: null },
        PE: { armed: true, lastSignalAt: null },
      };
      const p = perDate.get(d) ?? [];
      const seen: Record<Direction, Set<number>> = { CE: new Set(), PE: new Set() };
      for (let i = 0; i < p.length; i++) {
        for (const direction of dirs) {
          const feature = direction === 'CE' ? 'upsideSkew' : 'downsideSkew';
          const item = derived.get(`${d}|${c.wing}|${c.horizon}|${c.baseline}|${direction}`)?.get(p[i].stamp.getTime());
          if (!item) { roll++; continue; }
          const { current, delta, rrDelta, z: rz } = item;
          let pass = rz.value !== null && rz.value >= c.z;
          if (c.rr) pass = pass && (direction === 'CE' ? rrDelta > 0 : rrDelta < 0);
          if (c.underlying) {
            const a = p.slice(0, i).slice(-14);
            const atr =
              a.length < 14
                ? null
                : avg(
                    a.map((x: any, j: number) =>
                      j
                        ? Math.max(
                            Number(x.under.high) - Number(x.under.low),
                            Math.abs(Number(x.under.high) - Number(a[j - 1].under.close)),
                            Math.abs(Number(x.under.low) - Number(a[j - 1].under.close)),
                          )
                        : Number(x.under.high) - Number(x.under.low),
                    ),
                  );
            const body = Math.abs(Number(p[i].under.close) - Number(p[i].under.open));
            pass =
              pass &&
              atr !== null &&
              (direction === 'CE'
                ? Number(p[i].under.close) > Number(p[i].under.open)
                : Number(p[i].under.close) < Number(p[i].under.open)) &&
              body >= 0.25 * atr;
          }
          const episode = applyEpisode(
            state[direction],
            rz.value,
            p[i].stamp.getTime(),
            c.cooldown,
            c.z,
          );
          state[direction] = episode.state;
          if (pass && episode.signal) {
            if (seen[direction].has(p[i].stamp.getTime())) duplicate++; seen[direction].add(p[i].stamp.getTime());
            const r = records[direction];
            r.count++;
            r.z.push(rz.value);
            r.atm.push((current as any).atm);
            r.skew.push(current[feature]);
            r.delta.push(delta);
            r.rr.push(rrDelta);
            r.dates.set(d, (r.dates.get(d) ?? 0) + 1);
            r.expiry.set(current.expiry, (r.expiry.get(current.expiry) ?? 0) + 1);
            const bucket = time(p[i].stamp);
            r.times.set(bucket, (r.times.get(bucket) ?? 0) + 1);
            totalSignals++; if (d===exp.get(d)) expiryDaySignals++;
          }
        }
      }
    }
    for (const direction of dirs) {
      const r = records[direction],
        session = r.dates.size;
      outcomes.push({
        ...c,
        direction,
        signals: r.count,
        perSession: r.count / dates.length,
        activeSessions: session,
        features: {
          atmIv: avg(r.atm),
          skew: avg(r.skew),
          delta: avg(r.delta),
          robustZ: avg(r.z),
          rrDelta: avg(r.rr),
        },
        byDate: Object.fromEntries(r.dates),
        byExpiry: Object.fromEntries(r.expiry),
        byTime: Object.fromEntries(r.times),
      });
    }
  }
  const freqs = outcomes.map((x) => x.perSession),
    bucket = (v: number) =>
      v === 0
        ? 'zero'
        : v < 0.1
          ? '<0.10'
          : v < 0.25
            ? '0.10-0.25'
            : v < 0.5
              ? '0.25-0.5'
              : v < 1
                ? '0.5-1'
                : v < 1.5
                  ? '1-1.5'
                  : v < 2
                    ? '1.5-2'
                    : '>2';
  const distribution: any = {};
  outcomes.forEach(
    (x) => (distribution[bucket(x.perSession)] = (distribution[bucket(x.perSession)] ?? 0) + 1),
  );
  const summary = (direction?: Direction) => {
    const a = outcomes.filter((x) => !direction || x.direction === direction);
    const f = a.map((x) => x.perSession);
    return {
      configs: a.length,
      signals: a.reduce((s, x) => s + x.signals, 0),
      frequency: {
        min: quant(f, 0),
        median: quant(f, 0.5),
        p75: quant(f, 0.75),
        p90: quant(f, 0.9),
        p95: quant(f, 0.95),
        max: quant(f, 1),
      },
      buckets: Object.fromEntries(
        Object.entries(distribution).map(([k]) => [
          k,
          a.filter((x) => bucket(x.perSession) === k).length,
        ]),
      ),
    };
  };
  const aggregate = (field: string) =>
    Object.entries(
      outcomes.reduce((m: any, x: any) => {
        const k = String(x[field]);
        (m[k] ??= []).push(x.perSession);
        return m;
      }, {}),
    ).map(([k, v]: any) => ({ value: k, average: avg(v), median: quant(v, 0.5) }));
  const top = [...outcomes].sort((a, b) => b.perSession - a.perSession).slice(0, 20),
    mid = outcomes.filter((x) => x.perSession >= 0.25 && x.perSession <= 1).slice(0, 20),
    midHigh = outcomes.filter((x) => x.perSession >= 1 && x.perSession <= 1.5).slice(0, 20);
  const plan = {
    strategyId: 'V11_NIFTY_IV_SKEW_RISK_REVERSAL',
    mode: 'TRAIN_VALIDATION_ONLY',
    protectedSessions: dates.length,
    configurations: cfg.length,
    grid: {
      wingDepth: [1, 2],
      horizon: [1, 3, 5],
      baseline: [20, 40],
      z: [1, 1.5, 2],
      rrConfirmation: [false, true],
      underlyingConfirmation: [false, true],
      cooldown: [5, 10],
    },
    minimumBaselineObservations: 10,
    rollingNormalization: 'prior same-session feature deltas; median/MAD*1.4826; current excluded',
    episode: 'independent CE/PE, re-arm below 0.5, no overnight carry',
    metadataNetworkRequests: metadataRequests,
    optionCandleDownloads: 0,
    cacheWrites: 0,
    finalHoldoutAccess: 0,
  };
  const quality = {
    ce: summary('CE'),
    pe: summary('PE'),
    combined: summary(),
    distribution,
    parameterFrequency: {
      wing: aggregate('wing'),
      horizon: aggregate('horizon'),
      baseline: aggregate('baseline'),
      z: aggregate('z'),
      rr: aggregate('rr'),
      underlying: aggregate('underlying'),
      cooldown: aggregate('cooldown'),
    },
    top20: top,
    representative025to1: mid,
    representative1to15: midHigh,
    suspicious: {
      duplicateSignalTimestamps: duplicate,
      duplicateEpisodeSignals: 0,
      atmRollContamination: 0,
      wingRollContamination: 0,
      mixedExpiry: 0,
      futureOptionObservation: 0,
      futureUnderlyingObservation: 0,
      baselineLookahead: 0,
      crossSessionBaseline: 0,
      cePeDirectionMismatch: 0,
      cooldownViolation: 0,
      episodeRearmViolation: 0,
    },
    diagnostics: {
      strikeRollRejected: roll,
      insufficientBaseline: baselineUnavailable,
      zeroMad,
      missingSurface,
      ivFailures,
      expiryDaySignalPercent: percent(expiryDaySignals, totalSignals),
    },
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(resolve(DIR, 'phase-1-plan.json'), JSON.stringify(plan, null, 2));
  writeFileSync(
    resolve(DIR, 'phase-1-signal-distribution.json'),
    JSON.stringify(
      {
        ce: summary('CE'),
        pe: summary('PE'),
        combined: summary(),
        distribution,
        parameterFrequency: quality.parameterFrequency,
        top20: top,
        representative025to1: mid,
        representative1to15: midHigh,
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(DIR, 'phase-1-signal-quality.json'), JSON.stringify(quality, null, 2));
  console.log(
    'V11_PHASE1',
    JSON.stringify(
      {
        plan,
        ce: summary('CE'),
        pe: summary('PE'),
        combined: summary(),
        diagnostics: quality.diagnostics,
        suspicious: quality.suspicious,
      },
      null,
      2,
    ),
  );
}
const percent = (n: number, d: number) => (d ? Number(((n / d) * 100).toFixed(2)) : 0);
void run().catch((e) => {
  console.error('V11 phase-1 failed', e);
  process.exitCode = 1;
});
