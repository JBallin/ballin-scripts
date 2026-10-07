# Coverage identity diagnostic for #319

This unpublished driver is prepared for independent review. Publication and one
specific diagnostic dispatch require separate authorization. It does not run
the complete Ballin gate, change production source or thresholds, or qualify
the adaptive candidate.

The four fixed cells use Node 24.15.0 and 24.21.0, each loading the unchanged pure
`backup_cache.ts` module and an equivalent CommonJS control. Both official Linux
distributions have pinned checksums. One nonroot container uses `--init`, four
affinity CPUs, a two-CPU quota, and no network. Each child checks its own resource
bindings and asserts two fixed namespace results. Both runtimes use the same
locked c8 12.0.0 installation and Node 24.21 reporter process.

The source checkout must be exactly
`f6759244d12f3f6eac2141f4c8b6da90887acded` with tree
`d825bcfa9a8963e5061c006fda447934287857f6` and the recorded lock checksum. Setup
installs those locked dependencies with lifecycle scripts disabled. No Ballin
command, installer, backup workflow, real config, or production service runs.

The manual-only workflow reuses `ci.yml` on the separate
`experiment/319-coverage-identity` branch. Its input must match the exact reviewed
driver commit. The driver permits JBallin, that branch, attempt 1, and exactly
one current dispatch in branch-scoped history. Existing adaptive comparison
dispatch guards remain unchanged. There are no retries or automatic follow-ups.

Preparation has five minutes measured from the actual hosted job start. Each
probe and report has a twenty-second cap. Operations stop at nine minutes;
cleanup uses the remaining allocation within the ten-minute job. Runtime
assertion failure, interruption, cap, or reporter error stops subsequent cells.
A completed c8 threshold failure is retained as a diagnostic result and permits
the remaining fixed cells: all original thresholds remain enabled. No result
is described as a passing complete gate.

Raw profiles are written directly under the evidence directory and hashed before
reporting. Conversion retains source identity, ranges, real function counts,
source-map-cache entries, executed-file indexing, injected empty reports, merged
V8 data, Istanbul maps, summaries, strict checks, stdout/stderr, and exact terminal
exit receipts. The container ID is retained before start. Cleanup inspects the
exact owned name/ID and verifies its run/driver labels before removing that ID.
The final bounded log archive includes raw profiles even after failures. VM
teardown is not asserted.

The driver reuses only the independently reviewed process execution helper and
pinned Dockerfile from `../319-adaptive`, with explicit byte-hash checks. That
module's comparison entry point is never called. The source's `npm test` is never
invoked here. Local preparation validation is limited to syntax, workflow lint,
pure authorization/exit guards, and static review; the four fixture cells remain
unexecuted until a specifically authorized hosted dispatch.
