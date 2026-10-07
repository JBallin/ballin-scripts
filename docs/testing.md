# Testing and coverage

*Maintainer guide to test suites, coverage standards, runtime boundaries, and CI gates.*

Run commands from the repository root. Use `npm test` for the complete local
gate, or `npm run test:coverage` for coverage alone. CI runs the same coverage
command once.

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

Run `npm run test:unit -- test/claude_workflows.test.ts` for offline caller
regression tests covering eligibility, permissions, credential routing, runtime
pins, and model-free status refresh. They also run through `npm test`, use fixture
PR responses, and require no credentials, model calls, or host `jq` installation.
The fixtures evaluate the callers' current Actions conditions and jq eligibility
predicate in Node; response/error guards and shell wiring are checked structurally.
They do not execute Bash or validate the jq runtime. Shared runtime behavior is
tested in the runtime repository.

These are supported-source-form checks for the current thin callers. Direct-child
job keys must use the unquoted form, the eligibility job must contain only the
canonical checked `GITHUB_OUTPUT` emission, and the captured filter must retain
its active ordered response guards without comments. Secret access must retain
the approved dot reference; indexed access is rejected. Alternative valid YAML,
shell, jq, or Actions spellings intentionally fail closed until their coverage
is extended and reviewed.
The manual preflight's single step, authentication environment, shell prologue,
API capture, filter assignment, and final output form one canonical critical
block. These checks protect that source form and representative predicate
behavior; they do not prove arbitrary YAML or shell behavior. Eligibility
fixtures use each caller's configured event names and actions.
The supported direct workflow and job keys are explicit, so execution defaults,
matrix strategies, and quoted key alternatives fail closed. Rejected commands
and untrusted associations cover both comment events; fork and closed-PR cases
cover both status paths. Conditions and permission maps are captured through the
next job key or end, with internal blank lines and comments rejected rather than
truncating the checked section. The manual preflight retains `ubuntu-latest`.
These remain bounded coverage checks, not exhaustive
proof about arbitrary source changes.

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
removing that marker and retrying cleanup. Never run its installed command
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
node node_modules/c8/bin/c8.js report --check-coverage=false --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/local
CI=true npm run test:coverage
node node_modules/c8/bin/c8.js report --check-coverage=false --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/ci
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

When the coverage gate fails, CI attempts to retain exact reports and runtime,
commit, tree, and lockfile metadata in a compact artifact for seven days. A
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
Give each independent matrix combination its own `it` with the same assertions.
In [PR #438](https://github.com/JBallin/ballin-scripts/pull/438), three help tests
each bundled twelve independent CLI scenarios and exceeded the default two-second
timeout in Linux CI. That is evidence about the test boundary and process cost,
not evidence of intermittent flakiness or a reason to increase the global limit.

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
| Native Tab-completion cases | 20s | Isolated interactive shell and terminal subprocesses |
| Onboarding sandbox and walkthroughs | 300s | Outer allowance for multi-step command and process-group cleanup guards |

Recent Linux integration evidence includes a 2.122s installer case and a 7.137s
repository lifecycle case, supporting scoped headroom rather than a larger
default. Automated onboarding commands have a 120s child limit; interactive QA
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

A separate October 2, 2026 whole-suite pair used Node 24.21.0 on macOS arm64
and the frozen PR #438 head `8476f23`, including its split help matrix. Unit
execution took 222.34s; coverage took 241.09s, an observed 18.74s (8.43%)
overhead relative to unit execution. Both commands exited successfully with
1,486 passing tests and no pending tests. Coverage retained the configured gate
and reported 99.49% statements and lines, 97.27% branches and 100% functions.
This is one serial pair, not an estimate of timing variance or a comparison
between the earlier fixture patch and this later source tree.

The October 2, 2026 fixture-startup comparison used Node 24.21.0 on macOS arm64,
baseline `3c924f9`, and the helper change delivered in
[PR #437](https://github.com/JBallin/ballin-scripts/pull/437):

| Command and selection | Before | After | Observations |
| --- | --- | --- | --- |
| Unit, nine representative scenarios | 12.00s | 9.08s | Median of three alternating pairs |
| Coverage, the same nine scenarios | 12.57s | 9.77s | Median of three alternating pairs |
| Complete `npm test`, 1,427 tests | 272.44s | 238.30s | One pair |

The full pair saved 34.14s while preserving production coverage source maps and
covered/uncovered outcomes. It is one observation, not a runtime guarantee.
Repository lifecycle cases contributed at least 153s of the baseline's printed
test time, compared with about 35s for legacy backup; printed durations omit
fast cases and setup. Lint and both typechecks added about 2.1s to the optimized
local gate.

Linux CI on baseline `3c924f9` spent 476s in coverage within a 510s job. Merged
commit `1cb157a` passed 1,443 tests and spent 383s in coverage within a 408s job.
That merged tree includes other changes, so these runs are not a controlled
before/after estimate of the optimization. Use exact run provenance before
attributing differences to a patch or resource contention.

Retain serial execution and the single complete gate. Mocha's parallel workers
load required setup once per worker and can run multiple files, while the current
root `afterAll` removes its config and restores the environment after a file.
Worker reuse would need a compatible fixture lifecycle before enabling parallel
mode. Splitting suites adds maintenance cost without a demonstrated additional
benefit; use focused selection for feedback and retain complete final validation.

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

The September 30 discrepancy in PR #411 came from the old chmod-based uninstall
test skipping under root. CI's merge commit and the PR head had identical trees;
CI ran the test and covered the incomplete owned-link cleanup/reporting path.
Replacing only that fixture restores the missing coverage under the original
local Node version, without changing production code, analytics isolation,
coverage scope, or thresholds.

The nested-update analytics fixture injects a fixed clock so machine load cannot
move its event across the one-second duration boundary and add a covered V8
range without changing its assertions. Real CLI wrappers still measure elapsed
time, including when sending is disabled; sufficiently delayed processes can
cross duration boundaries and change V8 range maps. Such differences need
attribution even when covered lines and rounded totals match.
