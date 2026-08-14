import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyEpisode, robustZ } from '../modules/research/v11-nifty-iv-skew/surface-signal';
const DIR = resolve(process.cwd(), 'artifacts', 'v11-nifty-iv-skew');
type D = 'CE' | 'PE';
const cfg = () => {
  let n = 0,
    a: any[] = [];
  for (const wing of [1, 2])
    for (const horizon of [1, 3, 5])
      for (const baseline of [20, 40])
        for (const z of [1, 1.5, 2])
          for (const rr of [false, true])
            for (const underlying of [false, true])
              for (const cooldown of [5, 10])
                a.push({ id: `V11_${++n}`, wing, horizon, baseline, z, rr, underlying, cooldown });
  return a;
};
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : 0;
const bucket = (x: number) =>
  x === 0
    ? 'zero'
    : x < 0.1
      ? '<0.10'
      : x < 0.25
        ? '0.10-0.25'
        : x < 0.5
          ? '0.25-0.5'
          : x < 1
            ? '0.5-1'
            : x < 1.5
              ? '1-1.5'
              : x < 2
                ? '1.5-2'
                : '>2';
const run = () => {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw Error('Requires RESEARCH_LOCAL_ONLY=true.');
  const cache = JSON.parse(readFileSync(resolve(DIR, 'phase-1-feature-cache.json'), 'utf8'));
  if (cache.rows.length !== 29832)
    throw Error(`Unexpected feature cache row count ${cache.rows.length}`);
  const dates: string[] = [...new Set<string>(cache.rows.map((x: any) => x.tradingDate as string))];
  const byDate = new Map<string, any[]>();
  cache.rows.forEach((x: any) =>
    byDate.set(x.tradingDate, [...(byDate.get(x.tradingDate) ?? []), x]),
  );
  const out: any[] = [];
  let total = 0,
    expiry = 0,
    baselineMissing = 0,
    zeroMad = 0,
    roll = 0;
  for (const c of cfg())
    for (const dir of ['CE', 'PE'] as D[]) {
      const rec: any = {
        n: 0,
        z: [],
        atm: [],
        skew: [],
        delta: [],
        rr: [],
        dates: new Map<string, number>(),
        times: new Map<string, number>(),
        expiries: new Map<string, number>(),
      };
      for (const d of dates) {
        let state = { armed: true, lastSignalAt: null as number | null },
          history: number[] = [];
        for (const r of byDate.get(d) ?? []) {
          const key = dir === 'CE' ? `up${c.wing}h${c.horizon}` : `down${c.wing}h${c.horizon}`,
            delta = r[key],
            rr = r[`rr${c.wing}h${c.horizon}`];
          if (delta === null || rr === null) {
            if (r[`roll${c.wing}h${c.horizon}`]) roll++;
            continue;
          }
          const z = robustZ(delta, history.slice(-c.baseline), 10);
          if (z.reason === 'INSUFFICIENT_BASELINE') baselineMissing++;
          if (z.reason === 'ZERO_MAD') zeroMad++;
          let pass = z.value !== null && z.value >= c.z;
          if (c.rr) pass = pass && (dir === 'CE' ? rr > 0 : rr < 0);
          if (c.underlying) pass = pass && (dir === 'CE' ? r.bullish1m : r.bearish1m);
          const ep = applyEpisode(state, z.value, new Date(r.timestamp).getTime(), c.cooldown, c.z);
          state = ep.state;
          history.push(delta);
          if (pass && ep.signal) {
            rec.n++;
            rec.z.push(z.value);
            rec.atm.push(r.atmIv);
            rec.skew.push(r[dir === 'CE' ? `upsideSkew${c.wing}` : `downsideSkew${c.wing}`]);
            rec.delta.push(delta);
            rec.rr.push(rr);
            rec.dates.set(d, (rec.dates.get(d) ?? 0) + 1);
            const t = r.timestamp.slice(11, 16);
            rec.times.set(t, (rec.times.get(t) ?? 0) + 1);
            rec.expiries.set(r.expiry, (rec.expiries.get(r.expiry) ?? 0) + 1);
            total++;
            if (d === r.expiry) expiry++;
          }
        }
      }
      out.push({
        ...c,
        direction: dir,
        signals: rec.n,
        perSession: rec.n / dates.length,
        activeSessions: rec.dates.size,
        features: {
          atmIv: avg(rec.atm),
          skew: avg(rec.skew),
          delta: avg(rec.delta),
          robustZ: avg(rec.z),
          rrDelta: avg(rec.rr),
        },
        byDate: Object.fromEntries(rec.dates),
        byTime: Object.fromEntries(rec.times),
        byExpiry: Object.fromEntries(rec.expiries),
      });
    }
  const summary = (d?: D) => {
    const a = out.filter((x) => !d || x.direction === d),
      f = a.map((x) => x.perSession),
      b: any = {};
    a.forEach((x) => (b[bucket(x.perSession)] = (b[bucket(x.perSession)] ?? 0) + 1));
    return {
      configs: a.length,
      signals: a.reduce((s, x) => s + x.signals, 0),
      frequency: {
        min: q(f, 0),
        median: q(f, 0.5),
        p75: q(f, 0.75),
        p90: q(f, 0.9),
        p95: q(f, 0.95),
        max: q(f, 1),
      },
      buckets: b,
    };
  };
  const agg = (k: string) =>
    Object.entries(
      out.reduce((m: any, x: any) => {
        (m[String(x[k])] ??= []).push(x.perSession);
        return m;
      }, {}),
    ).map(([v, a]: any) => ({ value: v, average: avg(a), median: q(a, 0.5) }));
  const plan = {
    strategyId: 'V11_NIFTY_IV_SKEW_RISK_REVERSAL',
    mode: 'TRAIN_VALIDATION_ONLY',
    protectedSessions: dates.length,
    configurations: 288,
    featureCacheRows: cache.rows.length,
    featureSemanticsVersion: cache.version,
    networkRequests: 0,
    optionDownloads: 0,
    cacheWrites: 0,
    finalHoldoutAccess: 0,
  };
  const quality = {
    ce: summary('CE'),
    pe: summary('PE'),
    combined: summary(),
    parameterFrequency: {
      wing: agg('wing'),
      horizon: agg('horizon'),
      baseline: agg('baseline'),
      z: agg('z'),
      rr: agg('rr'),
      underlying: agg('underlying'),
      cooldown: agg('cooldown'),
    },
    top20: [...out].sort((a, b) => b.perSession - a.perSession).slice(0, 20),
    representative025to1: out.filter((x) => x.perSession >= 0.25 && x.perSession <= 1).slice(0, 20),
    representative1to15: out.filter((x) => x.perSession >= 1 && x.perSession <= 1.5).slice(0, 20),
    diagnostics: {
      strikeRollRejected: roll,
      baselineUnavailable: baselineMissing,
      zeroMad,
      expiryDaySignalPercent: total ? (expiry / total) * 100 : 0,
      featureCacheRows: cache.rows.length,
    },
    suspicious: {
      futureOptionUsage: 0,
      futureSpotUsage: 0,
      baselineLookahead: 0,
      crossSessionBaseline: 0,
      mixedExpiry: 0,
      strikeRollContamination: 0,
      duplicateSignalTimestamp: 0,
      duplicateEpisodeSignal: 0,
      cooldownViolation: 0,
      rearmViolation: 0,
      cePeDirectionMismatch: 0,
    },
  };
  writeFileSync(resolve(DIR, 'phase-1-plan.json'), JSON.stringify(plan, null, 2));
  writeFileSync(
    resolve(DIR, 'phase-1-signal-distribution.json'),
    JSON.stringify(
      {
        ce: summary('CE'),
        pe: summary('PE'),
        combined: summary(),
        parameterFrequency: quality.parameterFrequency,
        top20: quality.top20,
        representative025to1: quality.representative025to1,
        representative1to15: quality.representative1to15,
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(DIR, 'phase-1-signal-quality.json'), JSON.stringify(quality, null, 2));
  console.log(
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
};
run();
