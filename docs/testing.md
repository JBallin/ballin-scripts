# Testing and coverage

*Maintainer guide to test suites, coverage standards, runtime boundaries, and CI gates.*

Run commands from the repository root. Use `npm test` for the complete local
gate, or `npm run test:coverage` for coverage alone. CI calls the same lint,
typecheck and coverage scripts in separate steps. Its sequence duplicates the
local `test` script; keep both definitions aligned when changing validation.
Both paths use the shared Mocha command in `test:unit`. The
[Mocha configuration](../.mocharc.js) uses two workers when Node reports at least
four available CPUs and runs serially on smaller hosts.

The coverage command uses `test/coverage.ts` to correct c8 12.0.0's indexing of
executed absolute script paths. It retains `all: true` and every coverage threshold;
unexecuted included files still count as uncovered. Use the same wrapper when
reporting saved profiles, and review the compatibility correction when updating c8.

## Pull request review

The [automatic](../.github/workflows/claude-review.yml),
[manual](../.github/workflows/claude.yml), and
[status](../.github/workflows/claude-review-status.yml) callers are the source of
truth for Ballin's installed immutable [Claude Review Runtime](https://github.com/JBallin/claude-review-runtime)
revision. See the [runtime setup and review guide](https://github.com/JBallin/claude-review-runtime/blob/main/docs/consumer-workflows.md)
for shared setup, behavior, and review verification.

Opened or newly ready same-repository PRs receive one automatic review; drafts,
forks, and Dependabot-triggered runs are excluded. Pushes and base retargets
refresh existing presentation without running Claude. For a fresh review of an
open, non-draft, same-repository PR, a human owner, member, or collaborator can
post `/claude-review` as the entire top-level or inline PR comment.

Each accepted automatic or manual review can consume the existing Claude
subscription and shares the captured checkout, PR metadata, and diff with Claude.
Closing the PR or converting it to a draft does not cancel an accepted request.

## Interactive QA sandbox

Use Node.js from `.nvmrc`, install development dependencies with `npm ci`, then
run:

```shell
npm run sandbox
```

The tool prints its temporary sandbox paths and starts the real installer. Answer
the normal prompts, then use the sandbox menu to run installed commands:

```text
ballin doctor
ballin update
ballin backup setup
ballin backup
ballin backup open
ballin backup read zshrc.sh
inspect
exit
```

For maintenance-only onboarding, decline backup setup. `doctor` and `update` run
against the isolated installation and controlled tools. The default macOS update
stage uses a fake `softwareupdate` command; other optional host maintenance tools
are absent. Self-update uses a fake Git checkout update. Backup setup uses
a fake personal GitHub account and repository, sharing the automated walkthrough
fixtures. `backup open` records a fake browser request. No browser opens and no
GitHub login is needed. The sandbox includes a harmless `.zshrc` so sensitive-source
review has a concrete source to display.

To repeat setup without recreating the checkout, run `reset create` or
`reset reconnect`, then `ballin backup setup`. Both clear the local backup
association, sensitive-source choice, automatic-backup choice, and comparison
cache. The create reset supplies a missing fake destination; the reconnect reset
supplies an existing valid fake backup. These resets replace the fake remote
history. `reset fresh` removes the sandbox installation and fake destination;
run `install` to repeat all onboarding prompts. Other sandbox home files remain.

`inspect` prints local config, fake Git command logs, and current fake repository
contents. The printed paths also let you inspect the cache and full fake request
history using your editor. Menu arguments are separated by whitespace; shell
quoting, expansion, pipelines, and arbitrary shell commands are unavailable.

### Controlled failure walkthroughs

Use `scenarios` to list the allowlisted catalog, `scenario <name>` to select one,
and `clear` to remove faults. The menu shows the active scenario. Selection and
clearing retain installed config, fake remote commits and requests, and comparison
cache. Clearing does not undo writes or reconcile divergent files. The `reset`
commands above remain destructive and also clear the active scenario.

Installer faults can be selected before the first prompt:

```shell
npm run sandbox -- --scenario auth
```

Alternatively, cancel the initial installer, select a scenario in the menu, and
run `install`. For the backup cases below, enable backup, include the sandbox's
harmless sensitive source (`.zshrc`), and choose create during setup. Decline
analytics unless testing consent; even opt-in saves consent only in temporary
config, creates no analytics install ID, and sends no telemetry because the hard
`BALLIN_NO_ANALYTICS=1` guard remains active.

| Scenario | Setup and command | Expected outcome and recovery |
| --- | --- | --- |
| `auth` | Select before installation; enable backup, or run `ballin backup setup` | Authentication fails. `clear`, then retry setup; the installation remains available. |
| `connection`, `timeout` | Same setup as `auth` | Fixture transport error stops setup. `clear`, then retry setup. These simulate responses, not real network timing. |
| `permission` | Finish backup setup; select, then `ballin backup` | Publication is denied with no new commit. `clear`, then retry backup. |
| `ambiguous` | Finish backup setup; select, then `ballin backup` | Write succeeds despite a lost response; readback confirms it. `inspect`, `clear`, and retry to verify no duplicate commit. |
| `readback` | Finish backup setup; select, then `ballin backup` | Write succeeds, but unexpected remote content prevents confirmation. `inspect`, `clear`, and retry; the prior write remains and no duplicate snapshot commit is needed. |
| `conflict` | Finish setup and run a successful `ballin backup`; then select and run `ballin backup` again | Selection requires matching local, cache and remote zshrc bytes, then changes both sides. Backup refuses the conflict. `clear` preserves divergence. In your editor, copy the fake remote `zshrc.sh` contents shown by `inspect` into the printed temporary HOME's `.zshrc`; retry backup to accept that version without a duplicate remote commit. |
| `self-update` | Install, select, then `ballin self-update` | Controlled Git fetch fails. `clear`, then retry. |
| `update-failure` | Install with default maintenance settings; select, then `ballin update` | The fake macOS stage fails; Ballin self-update and readiness still run, and the command exits nonzero. `clear`, then retry. |
| `update-interrupt` | Install, select, then `ballin update` | Wait for “Sandbox update stage ready for interruption” (also recorded in `update-stage.ready` under the printed root), then press Ctrl-C. The process group stops and the sandbox is preserved. Inspect it, clean it up with the printed command, and start a new session without the scenario to retry. |
| `none` | `clear` or `scenario none` | Normal controlled tools and fake services. |

For a temporary-config corruption walkthrough, install and use your editor to
save a copy of the printed checkout's `ballin.config.json` outside that checkout
but inside the sandbox root. Replace the original with invalid JSON, run
`ballin doctor`, restore the saved bytes, and retry. Do not edit the installed
checkout or config outside the sandbox.

The catalog covers representative faults rather than every fixture combination.
Filesystem-permission selectors and real authentication/network checks, host-tool
installation, and real macOS updates are excluded. Existing automated tests cover
path-specific permission failures, decline/EOF, ordinary failures, and session
interruption. Scenario selection accepts no shell commands or environment overrides.

Normal exit or EOF cleans up automatically. Start with
`npm run sandbox -- --keep`, or enter `keep`, to preserve the sandbox.
Failed commands, safeguard failures, and interruptions preserve it for debugging.
Interrupting a running command stops its child process group before the session
finishes. Preserved sandboxes are inspection artifacts; start a new session to
run more commands. Remove a preserved or abandoned sandbox with the exact path
printed by the tool:

```shell
npm run sandbox -- --cleanup /path/printed/by/the/tool
```

Cleanup accepts only a marked temporary sandbox root and refuses a still-running
parent or recorded child process group, including children surviving a parent
crash. If a crash leaves an ambiguous launch marker, cleanup refuses rather than
assuming that no child started; inspect and stop the sandbox processes before
removing that marker and retrying cleanup. On Linux, verified zombie or dead
processes do not block cleanup; live processes and unavailable or ambiguous
liveness inspection still do. Never run its installed command
directly from your normal shell: the menu supplies the isolation safeguards on
every launch.

The harness uses an allowlisted child environment, temporary HOME/auth/config/
cache paths, a closed PATH, validated command stubs, disabled analytics, and a
Node preload that blocks network calls and uncontrolled child launches. Missing
or changed safeguards stop execution. It uses the actual production installer
and commands; it is a guard against accidental effects from trusted repository
code, **not an OS sandbox for hostile code**. Do not add host tools to its PATH,
remove its preload, or use it to run untrusted code.

## Test environment and analytics safety

Neither command needs an analytics opt-out or `CI=true` in your shell.
[Mocha setup](../test/setup.ts) isolates the config, sets `NODE_ENV=test` and
`BALLIN_NO_ANALYTICS=1`, and clears inherited `CI`, command-only analytics
suppression, Ballin overrides, and test fixture selectors before production
imports. Production commands still suppress analytics in CI.

Each parallel worker owns a separate config and retains it until process exit,
so reused workers and cached config modules see the same path. Normal process
exit removes the config. Tests must restore their own temporary environment
and module overrides.

Analytics-enabled tests use explicit environments, temporary install IDs, and
injected senders or mocked HTTPS requests. Installer, config, and public CLI
fixtures use complete child environments through the
[test environment helper](../test/helpers/environment.ts). The helper retains
c8's `NODE_V8_COVERAGE` without inheriting unrelated shell state or
`NODE_OPTIONS`. Node also propagates the coverage variable to existing
complete-environment fixtures, so those children remain measured.

Mocking HTTPS alone does not isolate analytics payload collection. The enabled
CLI fixture also selects macOS and stubs its version command before production
imports, exercising the default reader on every host. Separate analytics tests
cover the non-macOS fallback and injected readers.

Keep behavior selectors explicit in fixtures. Analytics flags can change the
measured branches; `BALLIN_BACKUP_HOST` and
`BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT` can change installer outcomes. Shared
setup clears these ambient values, and individual tests supply the overrides
needed for their scenarios.

Intentional exceptions and deliberately uncovered paths are recorded in the
[coverage boundary ledger](coverage-boundaries.md).

## Comparing coverage

Rounded global percentages can conceal different branch totals. To compare
coverage across parent environments, save each detailed report before the next
run replaces the raw coverage data:

```shell
npm run test:coverage
node test/coverage.ts report --check-coverage=false --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/local
CI=true npm run test:coverage
node test/coverage.ts report --check-coverage=false --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/ci
```

Compare exact totals in `coverage-summary.json` and file/source-location maps
and covered/uncovered outcomes in `coverage-final.json`, ignoring hit counts
and checkout path prefixes. Reconcile the checkout commit and Git tree, test
selection and passing/pending counts, runtime metadata (including UID), and
lockfile dependencies before attributing a mismatch to Node. A PR merge checkout
can have a different commit but identical tree. Use the same exact
Node/V8 version: `.nvmrc` selects Node 24, whose patch version can change.
Investigate residual differences rather than relaxing coverage thresholds or
excluding code.

When the coverage step fails after producing raw V8 coverage, CI attempts to
retain exact reports and runtime, commit, tree, and lockfile metadata in a compact
artifact for seven days. Failures before coverage starts skip these diagnostics. A
separate failure-only artifact upload retains the raw V8 data when available,
even if compact report generation fails. An intentional successful
`workflow_dispatch` run retains only the compact evidence. Ordinary successful
pull request and push runs skip diagnostic report generation and artifact
uploads. Compare retained evidence with the corresponding local run before
attributing a difference to the OS or runtime. Platform-dependent execution can
also change V8's range boundaries, so one newly uncovered branch may change
both covered and total branch counts.

## Test runtime and timeouts

Use `npm run test:unit` for a focused development run, for example:

```shell
npm run test:unit -- --grep 'scenario name'
```

Keep `npm test` as the complete local gate. A gate passes only when the command
finishes successfully and all required stages complete; a passing Mocha count
alone does not establish that coverage checks or later stages passed. A killed,
interrupted, tool-expired, or disconnected command without a confirmed exit
status is incomplete. Record the command, last completed stage, and diagnostic
output. Distinguish that interruption from Mocha reporting a test timeout.

Before adding timeout headroom, remove unnecessary waits and accumulated work.
Give each independent matrix combination its own `it` with the same assertions,
so repeated CLI startup does not consume one case's default two-second budget.

Keep a focused override when one coherent integration workflow legitimately
needs more time. Existing Mocha allowances apply to each test or hook in their
scope, rather than the combined suite runtime.

The inventory identifies current limits. Justify test boundaries and allowance
choices from the behavior and guards in each case.

| Scope | Allowance | Purpose |
| --- | --- | --- |
| Tests without an override | 2s | Default Mocha limit |
| Selected installer, analytics, backup and update cases | 5s | Coherent process workflows, concurrent repair, or bounded sender failures |
| Update interruption cases | 8s | Readiness handshake and a separate 5s child-process watchdog |
| Repository lifecycle and nested-update backup | 15s | Multiple real CLI and fixture processes within one workflow |
| Local snapshot budget cases | 30s | Capture size, recursive entry limits, and cache comparisons |
| Selected shell completion cases | 10s, 20s, 30s or 60s | Isolated shell and terminal subprocesses across completion scenarios |
| Onboarding sandbox and walkthroughs | 300s | Outer allowance for multi-step command and process-group cleanup guards |

Process-heavy integration workflows can need scoped headroom beyond the default.
Automated onboarding commands have a 120s child limit; interactive QA
test wrappers have a 240s limit. They check shutdown and preserve ambiguous live
session state. These are guard budgets, not expected runtimes. Any adjustment
must account for nested command limits and cleanup, as well as measured case
duration. Use readiness signals rather than fixed sleeps to coordinate children.

### Measuring runtime

Coordinate a quiet local window with no overlapping test suites. Hold the source
tree, runtime, dependencies and test selection fixed using the provenance rules
in [Comparing coverage](#comparing-coverage). Record wall time, exit status,
passing/pending counts and per-case durations for each command. Preserve stdout
and stderr, and compare `npm run test:unit` with `npm run test:coverage` on that
same checkout when estimating whole-suite instrumentation overhead. Focused
results cannot establish whole-suite overhead, and macOS and Linux timings are
not interchangeable.

Measured results identify repeated CLI launches and fixture startup as major
runtime contributors. In one serial whole-suite comparison at `8476f23` on
macOS arm64 with Node 24.21.0, coverage instrumentation added about 8% to unit
execution time. That single pair does not characterize timing variance.

Historical complete-gate comparisons at `c587fa6` and `2951bb1` on four-CPU Ubuntu
runners with Node 24.21.0, Mocha 11.7.6 and c8 12.0.0 showed median wall-time
reductions of about 17–20% with two workers. Statement/function outcomes and
effective V8 covered/uncovered intervals matched serial execution; branch-map
geometry varied. Coverage thresholds and Mocha timeouts were preserved. These
measurements support the shared configuration's two-worker setting on hosts with
at least four available CPUs.

The configuration retains serial execution below four available CPUs to limit
contention between subprocess-heavy suites. Serial checks passed with two-CPU
affinity on Node 24.21.0 and a two-CPU quota on Node 24.15.0; each is a single
smoke check. Node supplies the CPU estimate through `os.availableParallelism()`.

Benchmark reductions describe command wall time and exclude runner queue, setup
and evidence capture. Machine load, platform, runtime and source changes can alter
timing and coverage geometry. Use focused selection for feedback, retain the
single complete final gate, and verify that the full CI job fits its 20-minute
budget.

## Runtime and platform limits

Node options and preloads take effect before Mocha setup and are not equivalent
runtime configurations. OS metadata and filesystem behavior still vary between
macOS and Linux. Chmod-based permission behavior depends on host privileges and
capabilities, so UID is not a reliable test oracle. The uninstall denial fixture
injects a path-scoped `unlinkSync` failure with `EACCES` before production
imports, leaving its temporary link intact while cleanup removes another owned
link. The separate `ENOENT` fixture actually removes its link before throwing,
preserving its disappearance-race contract. Both run without contacting real
user state.

The nested-update analytics fixture injects a fixed clock so machine load cannot
move its event across the one-second duration boundary and add a covered V8
range without changing its assertions. Real CLI wrappers still measure elapsed
time, including when sending is disabled; sufficiently delayed processes can
cross duration boundaries and change V8 range maps. Such differences need
attribution even when covered lines and rounded totals match.
