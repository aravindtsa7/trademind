console.log('Replay recording is attached to normal market-data runtimes. Do not use this command to start a runtime.');
console.log('Windows CMD example for the next market session:');
console.log('set MARKET_REPLAY_RECORD=true && set MARKET_REPLAY_RUNTIME_ID=paper-v2 && npm run paper:v2');
console.log('Replay later: npm run replay:verify -- --file artifacts/market-replay/YYYY-MM-DD/paper-v2.jsonl');
