process.env.RESEARCH_DIRECTION = 'UP';
process.env.RESEARCH_PREPARE_ONLY = 'true';
if (process.env.RESEARCH_PREPARE_DIAGNOSTICS === undefined) process.env.RESEARCH_PREPARE_DIAGNOSTICS = 'true';
void import('./test-trend-down-pe-multitimeframe-research');
