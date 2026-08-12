# Forward-validation methodology

Forward evidence begins strictly after the legacy research end date (`2026-08-04`). Journals are append-only JSONL files under `artifacts/forward-validation/<strategyId>/`, one file per trading date. A strategy fingerprint is a deterministic SHA-256 prefix of its frozen rule parameters; a fingerprint mismatch refuses to merge observations.

Theoretical entry/exit prices remain separate from executable estimates. For a long option, a fresh ask is used for estimated entry and a fresh bid for estimated exit. When the feed exposes only LTP, the estimate is explicitly labeled `ESTIMATED_LTP`/`LTP_ONLY`. Missing or stale quotes never receive an invented price. The default stale threshold is 2,000 ms and is configurable in capture integrations.

The current decoded market-data model exposes LTP and a separate depth event type with bid/ask fields. Existing runtime paths currently consume LTP for paper/shadow observation; they do not fabricate bid/ask values. Future quote-aware integrations should consume the depth event and pass its timestamp through the shared normalizer.

Forward journals are evaluation data. They must not be used to tune frozen thresholds or exits. If rules change, create a new strategy version and fingerprint with a separate journal. A failed strategy cannot be repeatedly retuned against the same forward dataset and still call it unseen.

`npm run report:forward-validation` is local-only: it reads journals and writes `artifacts/forward-validation/forward-validation-summary.json`; it performs no network requests.
