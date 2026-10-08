# AGENTS.md

## Repo map

- `bin/ballin` is the stable, extensionless public entry point and must remain a
  tiny Node shim. Put typed CLI implementations under `commands/` or the feature
  folder that owns them, and configuration code under `config/`.
- Node-side TypeScript runs directly in Node. Do not introduce generated
  JavaScript, build output, runtime transpilers, or bundlers for those surfaces.
  Preserve executable modes and the existing shebang and installed-symlink
  coverage when changing public entry points.
- `install.sh` is Bash bootstrap/install glue, not part of the installed command
  shim. It delegates current setup behavior to `commands/install_setup.ts`.
- `analytics-worker/src/index.ts` is a Cloudflare Workers entry point deployed
  through the existing Wrangler toolchain, not a direct-Node CLI surface. The
  folder also owns D1 migrations, reporting/reset utilities, and deployment
  verification; preserve the isolation and data policy in its README.

## Local commands

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- For code, config, script, or test changes, run targeted local checks for the
  touched behavior before publication or review. Follow
  [Test runtime and timeouts](docs/testing.md#test-runtime-and-timeouts) for
  focused commands. Rely on PR CI for the complete validation gate before merge;
  `.github/workflows/ci.yml` defines its checks, and `package.json` defines the
  Node validation commands. Run complete validation locally when it supplies
  needed evidence unavailable from CI, diagnoses a material concern, or an
  explicit instruction requires it. If required CI is still running, report it
  as pending.
- Report validation as passing only after the command completes successfully.
  A killed, interrupted, tool-expired, or disconnected run without a confirmed
  exit status is incomplete, even if its output includes passing tests.
  Distinguish a Mocha test timeout from an interrupted validation command;
  retain the command, last completed stage, and failure or interruption evidence.
- Add focused validation when a touched risk is not covered by `npm test`;
  `.github/workflows/ci.yml` defines the additional shell and workflow checks.
  Run extra workflow/preflight checks only for related changes. For pin-only
  edits, prefer portable caller-contract tests locally and rely on CI for
  tool-dependent checks; see [Pull request review](docs/testing.md#pull-request-review).
- When changing shared validation commands, prerequisites, package metadata, or
  CI setup, review materially affected non-PR automation consumers and update
  their trigger, setup, and validation contracts as needed.
- For docs-only changes such as README or guide edits, skip local validation
  and rely on CI for automated checks.

## Testing and safety

- For new or changed interactive user flows, assess `npm run sandbox` walkthrough
  coverage and extend it when useful beyond existing isolated tests. Exercise
  relevant supported flows, including proportionate failure, retry, and
  cancellation cases; report existing coverage, limits, or blockers when a
  walkthrough is unavailable. Internal-only changes do not require an
  interactive path, and walkthroughs do not require duplicating the full suite.
  Follow [Interactive QA sandbox](docs/testing.md#interactive-qa-sandbox) for
  usage and safeguards. It supplements `npm test` and automated regression
  coverage. Its controlled tools and services do not verify live network access,
  authentication, or host-tool installation.
- Do not exercise Ballin's install, uninstall, update, backup, Homebrew,
  GitHub/Gist, global-package, `softwareupdate`, symlink, Cloudflare/Wrangler,
  D1, deploy, migration, production report/reset, or similar environment-affecting
  behavior against real user or production state.
- Do not manually smoke-test those flows. Representative validation must use
  temporary roots, fixture files, isolated config, complete child-process
  environments, command stubs or fake platform bindings, and existing test
  harness hooks. Reuse existing isolation seams before adding new test-only
  production hooks.

## Synchronization points

- When adding or changing public commands, keep dispatch, help, completion,
  documentation, analytics classification, and tests aligned where applicable.
  Backup and config operations share pure command-owned name definitions with
  completion generation. Run `npm run generate:completions` after changing those
  names; tests check the committed shell assets against generated output.
- When installer behavior or invocation changes, update its tests and the
  corresponding guidance in `README.md` and `docs/installation.md`.
- When configuration defaults or schema change, update
  `config/.defaultConfig.json`, relevant validation and consumers, tests, and the
  owning user documentation. Change `config/updateConfig.ts` only when migration
  behavior itself must change.
- Use `docs/README.md` to find the relevant guide, and use that guide's stated
  audience to judge its abstraction level, detail, and framing. For
  documentation, CLI/help text, and other user-facing copy, apply the relevant
  copy, voice, messaging, terminology, and naming guidance in
  `docs/design-system.md` according to the surface's job and audience. Use Ballin
  for product prose, `ballin` for the executable and command examples, and
  `ballin-scripts` for repository, package, checkout, or path precision.
