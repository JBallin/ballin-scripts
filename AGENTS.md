# AGENTS.md

## Repo map

`ballin-scripts` is a small personal automation toolkit. User-facing command
names live as stable extensionless files under `bin/`, with Bash implementations
still allowed there. Migrated Node-backed command implementations live under
`commands/`, config code lives under `config/`, and the Mocha tests in `test/`
exercise scripts, shims, and configuration helpers.

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

## Shell, config, and docs

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep extensionless `bin/*` commands stable unless a change intentionally
  updates their public behavior. When migrating a command to Node, keep `bin/*`
  as a tiny shim and put the typed implementation under `commands/` or the
  feature folder that owns it. TypeScript source under `commands/` and `config/`
  is executed directly by Node. Preserve executable modes and existing
  shebang/symlink coverage for user-facing commands.
- Keep `config/.defaultConfig.json`, `config/updateConfig.ts`, and config tests
  in sync when adding or changing settings.
- `docs/optional-capabilities.md` covers Node.js setup, optional integrations,
  and `up` settings; update it when those user-facing choices change.
