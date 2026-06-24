# AGENTS.md

## Repo map

`ballin-scripts` is a small personal automation toolkit. Most user-facing behavior
lives in Bash scripts under `bin/` and in `install.sh`. The Node.js layer in
`config/` manages `ballin.config.json`, and the Mocha tests in `test/` exercise
the shell scripts and config helpers.

## Local commands

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- Run `npm test` after code, config, script, or test changes.
- CI also runs this empty-tree whitespace check; use it locally when investigating
  whitespace failures:

  ```sh
  git diff --check "$(git hash-object -t tree /dev/null)" HEAD
  ```

## Testing and safety

- Do not run install, uninstall, `up`, `gu`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or other network-affecting operations against the
  real user environment.
- Tests for install, uninstall, `up`, `gu`, Homebrew, Gist, GitHub, npm-global,
  `softwareupdate`, symlink, or network-affecting behavior must use temporary
  directories, fixture files, complete child-process environments, and command
  stubs instead of the real user environment.
- Follow the existing `spawnSync` harness style and hooks like
  `BALLIN_TEST_CONFIG_PATH`, `BALLIN_UNINSTALL_TEST_SYSTEM_ROOT`, and command-log
  stubs before adding new test escape hatches.

## Shell and config changes

- For shell changes, preserve CLI output and side effects unless the issue asks
  for behavior changes; watch quoting, globbing, paths with spaces, and
  executable modes on `bin/*` and `install.sh`.
- Keep `config/.defaultConfig.json`, `config/updateConfig.js`, and config tests
  in sync when adding or changing settings.
- Document user-facing optional behavior in `docs/optional-capabilities.md` when
  a setting changes how `up`, `gu`, install, or update commands behave.
