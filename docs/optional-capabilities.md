# Optional capabilities

This guide covers choices for the required Node.js setup, plus optional tools
and settings that extend Ballin. The defaults keep updates predictable
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

Node.js is required by Ballin; install it using whichever method fits
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

After installing Ballin, optionally let `ballin update` install newer
LTS releases:

```shell
ballin config set update.nvm true
```

`update.nvm` runs `nvm install --lts`; it does not update nvm itself. It defaults to
`false` because enabling it opts into newer LTS releases, and installing a new
Node.js version does not migrate your globally installed npm packages
automatically. If nvm cannot be loaded, `ballin update` reports the failure and
continues with its remaining updates. A failure to capture nvm's updated
environment is handled the same way; later stages use the previous environment.

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
the configured backup Gist. Backup is optional: declining it during install
produces a healthy maintenance-only Ballin installation and makes no `gh`
calls. Enable it during installation or later without reinstalling:

```shell
ballin backup setup
```

Setup prompts for the GitHub host, including GitHub Enterprise hosts, checks
`gh` authentication for that host, and either adopts an existing backup Gist or
creates a new one. `backup.id` is the opt-in signal; there is no separate
enabled or onboarding setting. When setup newly configures a destination, it
also offers a default-no choice to run `ballin backup` automatically after
`ballin update`. Change that preference later with:

```shell
ballin config set update.backup true
ballin config set update.backup false
```

Invalid `backup.id` values can be repaired with `ballin config reset`; a missing
or malformed `backup.host` can be repaired with `ballin backup setup`. See
[Installation and removal](installation.md#optional-backup-and-adoption) for
adoption, failure, and cache-transition behavior.

Setup creates backup Gists as [secret Gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists). Secret Gists are unlisted and not
searchable, but anyone with the URL or ID can view them, so treat both as
sensitive. To make one discoverable, make it public in GitHub after reviewing
it: backup snapshots can expose paths, usernames, tool choices, package lists,
and arbitrary content in allowed local config. Ballin does not scan or redact
allowed files, and public Gists cannot be made secret again. Review
[Backup sources and sensitivity](backup-sources.md) before opting in.

GitHub preserves Gist revision history and diffs. Ballin does not provide
history navigation, rollback, restore, or revision selection.

Secret Gists remain Ballin's current backup storage.
[#254](https://github.com/JBallin/ballin-scripts/issues/254) tracks the
longer-term evaluation of more secure storage options.

Use `ballin backup open` to open the configured backup Gist, or
`ballin backup read <file>` to print one saved snapshot.

Before updating, Ballin checks for conflicting changes and stops safely if it
finds any. Use one active writer per backup Gist. See
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts) for
recovery guidance, guarantees, and limitations.

## Readiness checks

Use `ballin doctor` to check the managed environment. Maintenance-only Ballin
is healthy and does not invoke `gh`; configured backup failures affect overall
health. See [Supported capabilities](capabilities.md#ballin-doctor) for the
checks and their limitations.

```shell
ballin doctor
```

## Analytics

Ballin can send minimal anonymous usage analytics after a first-run
notice. See [Analytics](analytics.md) for what is sent, what is never sent, and
how long it is kept.

Disable persistently:

```shell
ballin config set analytics.enabled false
```

## `ballin update` settings

Change a setting with `ballin config set update.<name> true` or
`ballin config set update.<name> false`.

`ballin update` validates these settings before running any integration. Missing
known settings use bundled defaults in memory for the current run and appear in
one warning. The config file remains unchanged, and this behavior does not
depend on self-update. Malformed JSON, invalid config structure, or known values
other than booleans and canonical `"true"` or `"false"` strings fail before any
integration runs. Later stages continue after failures; if several fail, the
command returns the last nonzero stage status.

| Setting | Default | Behavior |
| --- | --- | --- |
| `update.cleanup` | `true` | Runs `brew cleanup` after upgrading Homebrew packages. |
| `update.selfUpdate` | `true` | Updates `ballin-scripts` when `ballin update` runs, then checks Ballin readiness if the update succeeds. |
| `update.backup` | `false` | Runs `ballin backup` to back up your development environment. Newly completed backup setup offers this choice with a default of no. Configure a destination with `ballin backup setup` before enabling it; an explicitly requested unconfigured backup stage fails with setup guidance. |
| `update.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `update.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `update.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |
