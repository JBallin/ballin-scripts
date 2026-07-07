# Optional capabilities

This guide covers choices for the required Node.js setup, plus optional tools
and settings that extend `ballin-scripts`. The defaults keep updates predictable
while letting you opt in to broader automation.

## Working with settings

Use `ballin config` to read and update local settings. Settings use dot paths,
such as `update.cleanup` or `analytics.enabled`.

```shell
ballin config
ballin config get update.cleanup
ballin config set update.cleanup false
ballin config reset
```

`ballin config` prints the full config, `get` prints one value, `set` updates
an existing setting, and `reset` restores the default config.

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
ballin config set update.nvm true
```

`update.nvm` runs `nvm install --lts`; it does not update nvm itself. It defaults to
`false` because enabling it opts into newer LTS releases, and installing a new
Node.js version does not migrate your globally installed npm packages
automatically. If nvm cannot be loaded, `ballin update` warns and continues
with its remaining updates.

For a simpler setup, install Homebrew's current Node.js release instead:

```shell
brew install node
```

With this option, Homebrew manages Node.js updates along with your other formulae.
The `update.nvm` setting does not apply.

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
an adopted backup includes a saved `ballin_config` snapshot, the installer restores
them before continuing.

Setup creates backup Gists as secret. Secret Gists are unlisted and not
searchable, but anyone with the URL can view them, so treat the backup Gist URL
as sensitive. To make one discoverable, make it public in GitHub after reviewing
it: backup snapshots can expose paths, usernames, tool choices, package lists,
and other local config, and public Gists cannot be made secret again.

Use `ballin backup open` to open the configured backup Gist, or
`ballin backup read <file>` to print one saved snapshot.

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

Change a setting with `ballin config set update.<name> true` or
`ballin config set update.<name> false`.

| Setting | Default | Behavior |
| --- | --- | --- |
| `update.cleanup` | `true` | Runs `brew cleanup` after upgrading Homebrew packages. |
| `update.selfUpdate` | `true` | Updates `ballin-scripts` when `ballin update` runs, then checks Ballin readiness if the update succeeds. |
| `update.backup` | `false` | Runs `ballin backup` to back up your development environment. Enable it when you want each update to also modify your backup gist. |
| `update.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `update.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `update.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |
