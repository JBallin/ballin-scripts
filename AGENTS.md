# AGENTS.md

## Repo map

`ballin-scripts` is a small personal automation toolkit. Most user-facing behavior
lives in Bash scripts under `bin/` and in `install.sh`. The Node.js code in
`config/` manages `ballin.config.json`, and the Mocha tests in `test/` exercise
the shell scripts and configuration helpers.

## Local commands

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- Run `npm test` after changes to code, config, scripts, or tests.
- TypeScript is checked with `tsc --noEmit` as part of `npm test`; production
  commands must remain runnable directly by Node without generated JavaScript,
  `dist/`, `ts-node`, `tsx`, Babel, or a bundler.

## Testing and safety

- Do not run install, uninstall, `up`, `gu`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or other network-affecting operations against the
  real user environment.
- Tests for install, uninstall, `up`, `gu`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or other network-affecting operations must use
  temporary directories, fixture files, complete child-process environments, and
  command stubs instead of the real user environment.
- Follow the existing `spawnSync` harness style, using hooks like
  `BALLIN_TEST_CONFIG_PATH`, `BALLIN_UNINSTALL_TEST_SYSTEM_ROOT`, and command-log
  stubs before adding new test escape hatches.

## Command implementation layout

- User-facing commands keep their stable, extensionless names under `bin/`.
  When a command needs Node.js implementation code, keep the `bin/*` file as a
  small shim and put the typed implementation next to the feature it owns. The
  first proof of concept is `bin/ballin_config`, which loads `config/cli.ts`
  beside the config helpers it orchestrates.
- Use the feature-local pattern first (`config/`, a future command-specific
  folder, or another existing domain folder) instead of adding a top-level
  `commands/` or `src/commands/` directory. Introduce a shared command directory
  only after several migrated commands need common structure that feature-local
  folders cannot provide cleanly.
- Node-backed command modules should export a runner such as
  `runConfigCli(args)`. The runner should accept parsed arguments, default to
  `process.argv.slice(2)` only at the CLI boundary, and return or print through
  a narrow boundary that is easy to exercise from tests.
- Keep file IO, environment reads, and child-process calls in helper functions
  that can be pointed at fixtures or command stubs, using the existing test
  hooks before adding new ones.
- Shims should stay intentionally small:

  ```js
  #!/usr/bin/env node

  require('../feature/cli.ts').runFeatureCli();
  ```

  This CommonJS `require()` style is intentional while the project relies on
  Node.js 24 native TypeScript type stripping.
- When migrating or adding a command, keep the installed command name and
  executable mode stable in `bin/`, expose implementation functions that tests
  can import directly, and cover user-facing shims with shebang and
  installed-symlink execution tests.
- See issue #132 for the `ballin_config` proof of concept and issue #130 for
  the parent shim architecture tracker.

## Shell, config, and docs

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep extensionless `bin/*` commands and Node-backed command entrypoints
  stable unless a change intentionally updates their public behavior.
  TypeScript source under `config/` is executed directly by Node.
- Keep `config/.defaultConfig.json`, `config/updateConfig.ts`, and config tests
  in sync when adding or changing settings.
- `docs/optional-capabilities.md` covers Node.js setup, optional integrations,
  and `up` settings; update it when those user-facing choices change.
