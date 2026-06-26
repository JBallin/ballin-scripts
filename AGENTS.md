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

## Command shims and typed code

- Keep user-facing command names stable and extensionless under `bin/`. Treat
  those files as the installed command surface, even when their implementation
  moves elsewhere.
- When a `bin/*` command delegates to Node.js code, prefer a tiny shim that
  loads a typed module from the feature area that owns the behavior. The current
  proof of concept is `bin/ballin_config` delegating to `config/cli.ts`.
- Keep typed command modules directly executable by Node.js 24 native
  type-stripping. Do not introduce production build output or runtime loaders
  such as `dist/`, `ts-node`, `tsx`, Babel, or a bundler.
- Export a small runner such as `runConfigCli(args)` from Node-backed command
  modules. Default to `process.argv.slice(2)` only at the CLI boundary so tests
  can call the runner or lower-level helpers with explicit inputs.
- Keep process IO, environment reads, file IO, and child-process calls behind
  narrow helpers that tests can point at fixtures, isolated environments, or
  command stubs. Reuse existing test hooks before adding new escape hatches.
- Cover user-facing Node shims with both direct shebang execution and
  installed-symlink execution tests.
- Use feature-local implementation files first (`config/`, a future
  command-specific folder, or another existing domain folder). If a migration
  seems to need a shared top-level command directory, capture that decision in
  the shim architecture tracker before adding the directory.
- Shim shape for Node-backed commands:

  ```js
  #!/usr/bin/env node

  require('../feature/cli.ts').runFeatureCli();
  ```

- Issue #130 tracks the broader shim architecture. Issue #132 is the
  `ballin_config` proof of concept.

## Shell, config, and docs

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep `config/.defaultConfig.json`, `config/updateConfig.ts`, and config tests
  in sync when adding or changing settings.
- `docs/optional-capabilities.md` covers Node.js setup, optional integrations,
  and `up` settings; update it when those user-facing choices change.
