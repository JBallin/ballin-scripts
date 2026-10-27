# Hosted worker comparison

This branch-only experiment runs the frozen application revision with the same
lifecycle-first native file manifest under two, then four Mocha workers on one
hosted runner. It does not change the application's worker policy.

The manual CI input `worker_comparison` selects this experiment instead of the
ordinary validation job. Each arm retains all coverage thresholds and test/child
timeouts, with a 25-minute outer command bound. A failed baseline prevents the
four-worker arm. Source hashes, file order, worker config lifetimes, complete test
identities, per-case timings, resource samples, reports and raw V8 profiles are
retained for seven days. The comparison checks effective V8 intervals rather
than requiring identical redundant covered-branch splits.

This is a single ordered pair: cache and host variation remain limitations.
Per-case times overlap across workers and cannot be added as wall-time savings.
No production worker-count change or merge is part of this experiment.
