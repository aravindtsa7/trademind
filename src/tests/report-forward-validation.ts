import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ForwardJournalRecord, summarizeForwardValidation } from '../modules/research-validation';

const root = resolve(process.cwd(), 'artifacts', 'forward-validation');
const output = resolve(root, 'forward-validation-summary.json');
const summary = {
  generatedAt: new Date().toISOString(),
  networkRequests: 0,
  V2: summarize('V2_TREND_DOWN_PE'),
  V4: summarize('V4_NIFTY_MOMENTUM_PE_SHADOW'),
};
mkdirSync(root, { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function summarize(strategyId: string) {
  const records = load(strategyId);
  return summarizeForwardValidation(strategyId, records);
}

function load(strategyId: string): ForwardJournalRecord[] {
  const directory = resolve(root, strategyId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) =>
      readFileSync(resolve(directory, file), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ForwardJournalRecord),
    );
}
