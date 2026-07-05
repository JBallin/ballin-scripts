# AGENTS.md

## Repo map

`ballin-scripts` is a small personal automation toolkit. User-facing command
names live as stable extensionless files under `bin/`. The `bin/*` commands are
tiny Node shims; command implementations live under `commands/` or the feature
folder that owns them, config code lives under `config/`, and the Mocha tests in
`test/` exercise scripts, shims, and configuration helpers. `install.sh` is
Bash bootstrap/install glue rather than part of the installed command-shim
surface.

## Local commands

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- Run `npm test` after changes to code, config, scripts, or tests.
- Do not add extra local validation by default; rely on CI for generic
  formatting and static checks unless a targeted risk calls for a focused check.
- For docs-only changes such as README or guide edits, skip local validation
  and rely on CI for automated checks.
- TypeScript is checked with `tsc --noEmit` as part of `npm test`; production
  commands must remain runnable directly by Node without generated JavaScript,
  `dist/`, `ts-node`, `tsx`, Babel, or a bundler.

## Testing and safety

- Do not run install, uninstall, `ballin update`, `ballin backup`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or other network-affecting operations against the
  real user environment.
- Tests for install, uninstall, `ballin update`, `ballin backup`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or other network-affecting operations must use
  temporary directories, fixture files, complete child-process environments, and
  command stubs instead of the real user environment.
- Do not manually smoke-test `install.sh` or `bin/ballin` with `uninstall`,
  `update`, or `backup` against the live checkout. If a direct invocation is
  needed, run it through the test harness with temp roots such as
  `BALLIN_UNINSTALL_TEST_SYSTEM_ROOT`, isolated config, and stubbed external
  commands.
- Follow the existing `spawnSync` harness style, using hooks like
  `BALLIN_TEST_CONFIG_PATH`, `BALLIN_UNINSTALL_TEST_SYSTEM_ROOT`, and command-log
  stubs before adding new test escape hatches.

## Shell, config, and docs

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep extensionless `bin/*` commands stable unless a change intentionally
  updates their public behavior. Keep `bin/*` as tiny shims and put typed
  implementations under `commands/` or the feature folder that owns them.
  TypeScript source under `commands/` and `config/` is executed directly by
  Node. Preserve executable modes and existing shebang/symlink coverage for
  user-facing commands.
- Treat `install.sh` changes as installer/bootstrap work. Do not assume it
  follows the same Node-shim pattern as installed `bin/*` commands; update
  README install guidance when the install invocation changes.
- Keep `config/.defaultConfig.json`, `config/updateConfig.ts`, and config tests
  in sync when adding or changing settings.
- `docs/optional-capabilities.md` covers Node.js setup, optional integrations,
  and `ballin update` settings; update it when those user-facing choices change.
