# Fixture responder qualification

The branch-only manual CI input `fixture_comparison` runs an unchanged frozen
baseline and the candidate responder on one hosted runner, sequentially, with
two workers in both arms. It uses the same dependency installation, source path,
lifecycle-first native test-file manifest, isolation observer, full coverage
thresholds and existing test/child timeouts. Each command has the same 25-minute
outer bound. Production CI settings on main are unchanged.

The application baseline is pinned in `prepare.js` and the checkout step. The
candidate overlay is restricted to the two helper files, TypeScript validation
configuration and its maintainer documentation. Manifest inventories validate
that delta and prove source stability across each arm. Both arms run normal
lint/typechecks; the unchanged shell/workflow/preflight checks also run. The
candidate runs even if the baseline test command fails, so evidence is retained
rather than treating a failed arm as a passing qualification.

Receipts, all test identities and case durations, file/worker/config traces,
resource samples, reports, raw V8 profiles and source manifests are retained.
Comparison requires matching outcomes and isolation; the independent effective
V8 pass compares covered/uncovered source intervals, allowing different counts
and redundant covered splits. Artifact packaging runs after failures. This is
one ordered pair, with cache/runner-time variation and no independent repeat;
per-case times overlap and cannot be summed into wall-time savings. No merge,
production adoption or worker-count change is part of this experiment.
