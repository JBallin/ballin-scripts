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

## Shell and config changes

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep `config/.defaultConfig.json`, `config/updateConfig.js`, and config tests
  in sync when adding or changing settings.
- Document new or changed user-facing configuration options in
  `docs/optional-capabilities.md`, including settings that affect `up`, `gu`,
  install, or update commands.
