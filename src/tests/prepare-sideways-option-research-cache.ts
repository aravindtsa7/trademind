process.env.RESEARCH_PREPARE_DIAGNOSTICS = 'true';
if (!process.env.RESEARCH_PREPARE_MANIFEST_PATH) process.env.RESEARCH_PREPARE_MANIFEST_PATH = '.research-cache-manifests/sideways-2026-08-04.json';
void import('./test-sideways-multitimeframe-option-premium-research');
