# Isolated ordering comparison

Manual `CI` workflow input `ordering_comparison` runs one sequential pair on the
same Ubuntu runner, frozen application revision a912440, identical dependencies,
two workers, coverage gates, timeouts and isolated per-arm HOME/TMPDIR roots.
The baseline queues lifecycle first and retains native order thereafter.
The candidate queues lifecycle first, Quickstart second, retaining every other
relative position. Application and production configuration are never modified.

The retained harness records exact manifests/source hashes, runner capacity,
commands, test identities/durations, file intervals, worker config lifetime and
cleanup, JSON coverage and raw V8 profiles. Both arms run even if one fails.
Each command retains the existing 25 minute bound; no test timeout is changed.
Raw effective coverage is compared independently from report branch multiplicity.
One pair screens this ordering; it does not establish repeatability or authorize
production adoption. No PR or merge is part of this experiment.
