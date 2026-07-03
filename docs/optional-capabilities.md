# Optional capabilities

This guide covers choices for the required Node.js setup, plus optional tools
and settings that extend `ballin-scripts`. The defaults keep updates predictable
while letting you opt in to broader automation.

## Working with settings

Use `ballin config` to read and update local settings. Settings use dot paths,
such as `up.cleanup` or `analytics.enabled`.

```shell
ballin config
ballin config get up.cleanup
ballin config set up.cleanup false
ballin config reset
```

`ballin config` prints the full config, `get` prints one value, `set` updates
an existing setting, and `reset` restores the default config. The existing
`ballin_config` command remains supported for direct use.

## Node.js

Node.js is required by `ballin-scripts`; install it using whichever method fits
your environment. For development, we recommend [nvm](https://github.com/nvm-sh/nvm)
with the latest Node.js long-term support (LTS) release. It supports switching
versions, project-specific `.nvmrc` files, and a user-local installation.

Follow nvm's official
[installation and shell setup instructions](https://github.com/nvm-sh/nvm#installing-and-updating),
then install Node.js LTS:

```shell
nvm install --lts
```

Installed commands use the `node` found on your shell `PATH`, so make sure new
terminal sessions use a supported Node.js version too.

After installing `ballin-scripts`, optionally let `ballin update` install newer
LTS releases:

```shell
ballin config set up.nvm true
```

`up.nvm` runs `nvm install --lts`; it does not update nvm itself. It defaults to
`false` because enabling it opts into newer LTS releases, and installing a new
Node.js version does not migrate your globally installed npm packages
automatically. If nvm cannot be loaded, `ballin update` warns and continues
with its remaining updates.

For a simpler setup, install Homebrew's current Node.js release instead:

```shell
brew install node
```

With this option, Homebrew manages Node.js updates along with your other formulae.
The `up.nvm` setting does not apply.

## Mac App Store apps

Install [`mas`](https://github.com/mas-cli/mas) with Homebrew to add Mac App
Store support:

```shell
brew install mas
```

When `mas` is available, `ballin update` updates installed App Store apps and
`ballin backup` includes the installed-app list in your backup. No configuration
setting is required.

## Gist backups

`ballin backup` uses [GitHub CLI](https://cli.github.com/) to read and update
the configured backup Gist. During install, `ballin-scripts` prompts for the
GitHub host, including GitHub Enterprise hosts, checks `gh` authentication for
that host, and either adopts an existing backup Gist or creates a new one. When
an adopted backup includes saved `ballin_config` values, the installer restores
them before continuing.

## Readiness checks

Use `ballin doctor` to check whether the Ballin-managed environment is healthy,
including Node.js, installed commands, settings, and Gist backup setup. Add
`--verbose` when you want the full check list.

```shell
ballin doctor
```

## Analytics

`ballin-scripts` can send minimal anonymous usage analytics after a first-run
notice. See [Analytics](analytics.md) for what is sent, what is never sent, and
how long it is kept.

Disable persistently:

```shell
ballin config set analytics.enabled false
```

## `ballin update` settings

Change a setting with `ballin config set up.<name> true` or
`ballin config set up.<name> false`.

| Setting | Default | Behavior |
| --- | --- | --- |
| `up.cleanup` | `true` | Runs `brew cleanup` after upgrading Homebrew packages. |
| `up.ballin` | `true` | Updates `ballin-scripts` when `ballin update` runs, then checks Ballin readiness if the update succeeds. |
| `up.gu` | `false` | Runs `ballin backup` to back up your development environment. Enable it when you want each update to also modify your backup gist. |
| `up.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `up.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `up.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |
