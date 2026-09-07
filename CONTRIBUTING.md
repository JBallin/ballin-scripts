# Contribution Guidelines

## Setup

1. Run the [install script](README.md#installation). Use the installed checkout
   at `~/.ballin-scripts` for contributor development; its `origin` points to
   the upstream `JBallin/ballin-scripts` repository.
2. Fork the repository on GitHub.
3. From `~/.ballin-scripts`, add your fork as an additional push remote without
   replacing `origin`:

   ```shell
   git remote add fork "$FORK_REPO"
   ```

## Development

Start new work by updating the installed checkout before creating your feature
branch. `ballin self-update` fetches `origin/main`, checks out `main`, and merges
`origin/main`. Run it before creating or switching to your feature branch;
otherwise it switches away from that branch and may stash changes during
recovery. Commit or stash any existing work first.

```shell
$ cd ~/.ballin-scripts
$ ballin self-update
$ git checkout -b "$BRANCH_NAME"
$ nvm use # If you use nvm
$ npm install
# MAKE CHANGES
$ npm test
$ git push --set-upstream fork "$BRANCH_NAME"
```

For more repo context, see [AGENTS.md](AGENTS.md).

## Tests and coverage

Run `npm test` for the complete local gate, or `npm run test:coverage` for
coverage alone. CI runs the same coverage command once. Neither command needs
an analytics opt-out or `CI=true` in your shell: Mocha setup isolates the config,
sets `NODE_ENV=test` and `BALLIN_NO_ANALYTICS=1`, and clears inherited `CI`,
command-only analytics suppression, Ballin overrides, and test fixture selectors.
Production commands still suppress analytics in CI.

Analytics-enabled tests use explicit environments, temporary install IDs, and
injected senders or mocked HTTPS requests. Installer, config, and public CLI
fixtures use complete child environments through `test/helpers/environment.ts`.
That helper retains c8's `NODE_V8_COVERAGE` without inheriting unrelated shell
state or `NODE_OPTIONS`. Node also propagates the coverage variable to existing
complete-environment fixtures, so those children remain measured.

Before this isolation, inherited analytics flags changed the measured analytics
branches, while `BALLIN_BACKUP_HOST` and the final-config-commit failure override
could change installer test outcomes. Rounded global percentages could conceal
different branch totals. To compare coverage across parent environments, save
each detailed report before the next run replaces the raw coverage data:

```shell
npm run test:coverage
node node_modules/c8/bin/c8.js report --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/local
CI=true npm run test:coverage
node node_modules/c8/bin/c8.js report --temp-directory=coverage/tmp --reporter=json --reporter=json-summary --reports-dir=coverage/ci
```

Compare exact totals in `coverage-summary.json` and file/source-location maps
and covered/uncovered outcomes in `coverage-final.json`, ignoring hit counts
and checkout path prefixes. Use the same commit, lockfile dependencies, and exact
Node/V8 version: `.nvmrc` selects Node 24, whose patch version can change. Node
options and preloads take effect before Mocha setup and are not equivalent
runtime configurations. OS metadata and filesystem behavior still vary between
macOS and Linux; the permission-denial uninstall test skips on Windows or when
running as root. Investigate residual differences rather than relaxing coverage
thresholds or excluding code.

The nested-update analytics fixture injects a fixed clock: it previously crossed
the one-second duration boundary depending on machine load,
adding a covered V8 range without changing its assertions. Real CLI wrappers
still measure elapsed time, including when sending is disabled; sufficiently
delayed processes can cross duration boundaries and change V8 range maps. Such
differences need attribution even when covered lines and rounded totals match.

## Suggestions Welcome

Please open issues (or PRs) with any suggestions for additions to `ballin backup`, `ballin update`, or anything else.
