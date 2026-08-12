process.env.RESEARCH_PREPARE_ONLY = 'true';
process.env.RESEARCH_V3_FAST_AUDIT = 'true';
if (process.env.RESEARCH_PREPARE_DIAGNOSTICS === undefined)
  process.env.RESEARCH_PREPARE_DIAGNOSTICS = 'true';

void import('./test-trend-down-pe-multitimeframe-research');
