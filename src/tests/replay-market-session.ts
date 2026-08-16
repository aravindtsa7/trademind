import MarketReplayRunnerService from '../modules/market-replay/market-replay-runner.service';

async function main(): Promise<void> {
  const argument = process.argv.find((value) => value.startsWith('--file=')) ??
    (process.argv.indexOf('--file') >= 0 ? `--file=${process.argv[process.argv.indexOf('--file') + 1]}` : undefined);
  const file = argument?.slice('--file='.length);
  if (!file) throw new Error('Usage: npm run replay:session -- --file <recording.jsonl>');

  const verify = process.argv.includes('--verify');
  const runner = new MarketReplayRunnerService();
  const events = runner.load(file);
  const first = await runner.run(events);
  const goldenTrace = runner.getLastOutputTrace();
  if (verify) {
    const second = await runner.run(events);
    if (first.outputDigest !== second.outputDigest) {
      const divergence = runner.findFirstDivergence(goldenTrace, runner.getLastOutputTrace());
      throw new Error(`Replay golden verification failed: output digest differs (first=${first.outputDigest}, second=${second.outputDigest}); firstDivergence=${JSON.stringify(divergence)}.`);
    }
  }
  const session = events[0]?.sessionId ?? 'replay-session';
  const resultPath = runner.writeResult(session, first);
  console.log(JSON.stringify({ resultPath, outputDigest: first.outputDigest, sourceFingerprint: first.sourceFingerprint, verified: verify, networkRequests: 0, cacheWrites: 0 }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
