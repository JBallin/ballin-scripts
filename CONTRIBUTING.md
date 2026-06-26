# Contribution Guidelines

## Setup

1. Run the [install script](README.md#installation)
2. Fork the repository on GitHub
3. Set the fork as a remote: `git remote add fork $FORK_REPO`

## Development

```shell
$ cd /path/to/ballin-scripts
$ ballin_update # Update project/config
$ git checkout -b $BRANCH_NAME
$ nvm use # If you use nvm
$ npm install
# MAKE CHANGES
$ npm test
$ git push fork $BRANCH_NAME
```

## Command Layout

User-facing commands should keep their stable, extensionless names under `bin/`.
When a command needs Node.js implementation code, keep the `bin/*` file as a
small shim and put the typed implementation next to the feature it owns. For
example, `bin/ballin_config` loads `config/cli.ts`, which lives beside the
config helpers it orchestrates.

Use that feature-local pattern first (`config/`, a future command-specific
folder, or another existing domain folder) instead of adding a top-level
`commands/` or `src/commands/` directory. Introduce a shared command directory
only after several migrated commands need common structure that feature-local
folders cannot provide cleanly.

Node-backed command modules should export a runner such as `runConfigCli(args)`.
The runner should accept parsed arguments, default to `process.argv.slice(2)`
only at the CLI boundary, and return or print through a narrow boundary that is
easy to exercise from tests. Keep file IO, environment reads, and child-process
calls in helper functions that can be pointed at fixtures or command stubs, using
the existing test hooks before adding new ones.

Shims should stay intentionally small:

```js
#!/usr/bin/env node

require('../feature/cli.ts').runFeatureCli();
```

This CommonJS `require()` style is intentional while the project relies on
Node.js 24 native TypeScript type stripping. Do not add generated JavaScript,
`dist/`, `ts-node`, `tsx`, Babel, or a bundler for production commands.

When migrating or adding a command:

- keep the installed command name and executable mode stable in `bin/`;
- expose implementation functions that tests can import directly;
- cover the shim with shebang and installed-symlink execution tests when the
  command is user-facing;
- use temporary directories, isolated environments, and command stubs for tests
  that touch install, uninstall, Homebrew, GitHub, Gist, npm-global, symlink, or
  other network-affecting behavior;
- update user-facing docs when configuration, dependencies, or optional
  integrations change.

The first proof of concept for this convention is the `ballin_config` migration
from [issue #132](https://github.com/JBallin/ballin-scripts/issues/132).

## Suggestions Welcome

Please open issues (or PR's) with any suggestions for additions to `gu`/`up` or anything else.
