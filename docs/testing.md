# Testing and coverage

Run commands from the repository root. Use `npm test` for the complete local
gate, or `npm run test:coverage` for coverage alone. CI runs the same coverage
command once.

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
node node_modules/c8/bin/c8.js report --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/local
CI=true npm run test:coverage
node node_modules/c8/bin/c8.js report --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/ci
```

Compare exact totals in `coverage-summary.json` and file/source-location maps
and covered/uncovered outcomes in `coverage-final.json`, ignoring hit counts
and checkout path prefixes. Use the same commit, lockfile dependencies, and exact
Node/V8 version: `.nvmrc` selects Node 24, whose patch version can change.
Investigate residual differences rather than relaxing coverage thresholds or
excluding code.

## Runtime and platform limits

Node options and preloads take effect before Mocha setup and are not equivalent
runtime configurations. OS metadata and filesystem behavior still vary between
macOS and Linux; the permission-denial uninstall test skips on Windows or when
running as root.

The nested-update analytics fixture injects a fixed clock so machine load cannot
move its event across the one-second duration boundary and add a covered V8
range without changing its assertions. Real CLI wrappers still measure elapsed
time, including when sending is disabled; sufficiently delayed processes can
cross duration boundaries and change V8 range maps. Such differences need
attribution even when covered lines and rounded totals match.
