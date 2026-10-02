# Testing and coverage

**Audience:** Maintainers

Run commands from the repository root. Use `npm test` for the complete local
gate, or `npm run test:coverage` for coverage alone. CI runs the same coverage
command once.

## Interactive onboarding QA

Use Node.js from `.nvmrc`, install development dependencies with `npm ci`, then
run:

```shell
npm run qa:onboarding
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
against the isolated installation and controlled tools; optional host maintenance
tools are absent. Self-update uses a fake Git checkout update. Backup setup uses
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
`npm run qa:onboarding -- --keep`, or enter `keep`, to preserve the sandbox.
Failed commands, safeguard failures, and interruptions preserve it for debugging.
Interrupting a running command stops its child process group before the session
finishes. Preserved sandboxes are inspection artifacts; start a new session to
run more commands. Remove a preserved or abandoned sandbox with the exact path
printed by the tool:

```shell
npm run qa:onboarding -- --cleanup /path/printed/by/the/tool
```

Cleanup accepts only a marked temporary sandbox root and refuses a still-running
session. Never run its installed command directly from your normal shell: the
menu supplies the isolation safeguards on every launch.

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
