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
ballin config --help
```

`ballin config` prints the full config, `get` prints one value, and `set` updates
an existing setting. Use `ballin config --help` for usage, even if the config
file is missing or unreadable.

Use `ballin config reset` to recover a missing or malformed config file. This
restores defaults and replaces saved settings. For read or save errors, check
the config file's permissions and its parent directory before retrying.

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
the active `gh` account for that host, and either adopts an existing backup
Gist or creates a new one. `backup.id` is the opt-in signal; there is no separate
enabled or onboarding setting. After creating or adopting a destination, setup
asks whether updates should run backups automatically, with yes as the default.
See [setup choices and recovery](installation.md#optional-backup-and-adoption).
Change that choice later with:

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
history navigation, rollback, or revision selection. Adoption restores eligible
Ballin preferences; it does not apply saved dotfiles or install saved packages.

Ballin currently stores backups in secret Gists.
[#254](https://github.com/JBallin/ballin-scripts/issues/254) completed the
storage-security evaluation. The portable-preference and shared inclusion
policy is recorded in [#332](https://github.com/JBallin/ballin-scripts/issues/332).
Future repository onboarding and migration are tracked in
[#333](https://github.com/JBallin/ballin-scripts/issues/333) and
[#334](https://github.com/JBallin/ballin-scripts/issues/334).

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

## Portable preferences

`ballin_config` exports only the six `update.*` preferences listed below,
`analytics.enabled` when it is exactly `"false"`, and the two inclusion
preferences `backup.includeRaw` and `backup.includeDetailed`. Destination
linkage (`backup.id`, `backup.host`), analytics identity, and unknown/custom
settings are excluded. They are not removed from local configuration.

For update and inclusion preferences, valid native booleans and exact
`"true"`/`"false"` strings export as canonical strings. Missing leaves are
omitted. Invalid local update or inclusion values stop the config snapshot
and the staged backup before remote snapshot reads or writes; diagnostics
identify the key without printing its value.

Adoption starts from local configuration. It restores valid update preferences
and the exact analytics opt-out only where the leaf was absent before setup
created or refreshed defaults. An existing leaf wins even when it equals the
bundled default or is invalid. Remote invalid/unknown values are ignored;
missing remote preferences or an absent snapshot leave local settings and
defaults intact.
Restoring update preferences affects later updates; adoption runs no update
integrations. Every newly configured backup still takes the local automatic
backup answer as final authority over local and restored values.

Both inclusion preferences default to `"false"`. A restored false can fill an
unchosen preference; a restored true is only a proposal requiring local source
review. Current Gist adoption neither activates nor saves that proposal.
Existing local choices remain intact. These fields support the
[shared inclusion policy](backup-sources.md#shared-inclusion-policy) for future
repository setup and migration; changing them does not change current Gist
source capture.

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
| `update.backup` | `false` | Runs `ballin backup` to back up your development environment. Configure a destination with `ballin backup setup` before enabling it; an explicitly requested unconfigured backup stage fails with setup guidance. |
| `update.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `update.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `update.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |
