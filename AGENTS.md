# AGENTS.md

## Repository context

`ballin-scripts` is a small personal automation toolkit. Most user-facing behavior
lives in Bash scripts under `bin/` and in `install.sh`. The Node.js layer in
`config/` manages `ballin.config.json`, and the Mocha tests in `test/` exercise
the shell scripts and config helpers.

## Development workflow

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- Run the full local check with `npm test`; this runs ESLint and Mocha.
- Before opening a PR, also run the whitespace check used by CI:

  ```sh
  git diff --check "$(git hash-object -t tree /dev/null)" HEAD
  ```

## Testing and safety

- Keep tests isolated from the real developer machine. Use temporary directories,
  fixture files, and command stubs instead of real Homebrew, Gist, GitHub, npm,
  macOS update, install, uninstall, or network behavior.
- Follow the existing `spawnSync` test style: pass complete child-process
  environments when that prevents real credentials, tools, config, or shell
  state from leaking in.
- Use the existing test escape hatches, such as `BALLIN_TEST_CONFIG_PATH`,
  `BALLIN_UNINSTALL_TEST_SYSTEM_ROOT`, and command-log stubs, before adding new
  ones.
- Keep tests deterministic and avoid depending on the developer machine's actual
  installed tools, global packages, Homebrew state, Gists, or dotfiles.

## Shell script guidance

- Preserve existing user-facing behavior unless the issue explicitly asks for a
  behavior change.
- Be careful with quoting, globbing, and paths that may contain spaces.
- Preserve executable bits on files under `bin/` and on `install.sh`.
- Prefer explicit checks and clear failure messages for operations that touch
  user config, symlinks, package managers, network-backed tools, or system update
  commands.
- When adding behavior that can affect the user's environment, add or update
  tests that prove it stays confined to the test harness.

## Config guidance

- Keep `config/.defaultConfig.json`, `config/updateConfig.js`, and config tests
  in sync when adding or changing settings.
- Document user-facing optional behavior in `docs/optional-capabilities.md` when
  a setting changes how `up`, `gu`, install, or update commands behave.

## Git hygiene

- Inspect the worktree before editing and preserve unrelated user changes.
- Keep commits focused on the issue being addressed.
- Do not encode personal Codex/session workflow preferences here; keep this file
  limited to durable repository guidance.

## PR notes

When opening a PR, include the issue being addressed, a concise summary of
behavior changes, and the local checks that were run.
