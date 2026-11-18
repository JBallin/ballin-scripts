# AGENTS.md

## Required guidance

- Follow [Development guide](docs/development.md) for repository structure,
  synchronization points, and documentation conventions.
- Follow [Validation workflow](docs/testing.md#validation-workflow) for local
  checks, CI gates, interactive coverage, and reporting incomplete runs.
- Contributor setup instructions describe human development workflows; they do
  not authorize agents to exercise environment-affecting behavior against real
  user or production state.

## Testing and safety

- Do not exercise Ballin's install, uninstall, update, backup, Homebrew,
  GitHub/Gist, global-package, `softwareupdate`, symlink, Cloudflare/Wrangler,
  D1, deploy, migration, production report/reset, or similar environment-affecting
  behavior against real user or production state.
- Do not manually smoke-test those flows. Representative validation must use
  temporary roots, fixture files, isolated config, complete child-process
  environments, command stubs or fake platform bindings, and existing test
  harness hooks. Reuse existing isolation seams before adding new test-only
  production hooks.
