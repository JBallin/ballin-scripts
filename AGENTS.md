# AGENTS.md

## Repo map

`ballin-scripts` is a small personal automation toolkit. User-facing command
names live as stable extensionless files under `bin/`. Current `bin/*`
commands are tiny Node shims; command implementations live under `commands/` or
the feature folder that owns them, config code lives under `config/`, and the
Mocha tests in `test/` exercise scripts, shims, and configuration helpers.
`install.sh` remains Bash bootstrap/install glue rather than part of the
installed command-shim surface.

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
- Do not manually smoke-test `bin/ballin_uninstall`, `bin/ballin_update`,
  `install.sh`, `bin/up`, or `bin/gu` against the live checkout. If a direct
  invocation is needed, run it through the test harness with temp roots such as
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
- For post-migration command work, preserve behavior unless an issue explicitly
  asks for a behavior change; keep broad refactors, product changes, and cleanup
  in focused issues or PRs.
- Treat `install.sh` changes as installer/bootstrap work. Do not assume it
  should follow the same Node-shim pattern as installed `bin/*` commands; update
  README install guidance only when the installer behavior intentionally
  changes.
- Keep `config/.defaultConfig.json`, `config/updateConfig.ts`, and config tests
  in sync when adding or changing settings.
- `docs/optional-capabilities.md` covers Node.js setup, optional integrations,
  and `up` settings; update it when those user-facing choices change.
