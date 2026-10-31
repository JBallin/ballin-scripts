# Optional capabilities

*User guide to choosing Node.js environments, optional tools, and update automation settings.*

Node.js is required; the other tools and integrations are optional. The defaults
keep updates predictable while letting you opt in to broader automation.

## Guided preference review

Run `ballin setup` to review local Ballin preferences without reinstalling:

```shell
ballin setup
```

Review global npm updates, Ballin self-updates, Homebrew cleanup, macOS updates,
and analytics using your saved choices as defaults. Answering a question saves
that preference; it does not run an update.

The NVM question appears when NVM can load and its default follows latest LTS,
or when NVM updates are already enabled. A default pinned to one version or
one named LTS line does not follow future LTS releases. New installations
recommend Yes on the first eligible review, even if NVM becomes eligible later.
A confirmed No remains No on reruns. Existing saved values stay authoritative.

The automatic-backup question appears when a valid backup is configured or the
setting is already enabled. Use `ballin backup setup` to choose or validate a
destination and review sensitive sources; general setup does not do that work.

Each confirmed choice is saved locally. Closing input or interrupting leaves the
pending choice unchanged and retains earlier confirmed choices. Repair invalid
configuration before reviewing it; missing config is created with defaults.
Use `ballin config get/set/reset` for direct configuration.

## Working with settings

Use `ballin config` to read and update local settings. Settings use dot paths,
such as `update.cleanup` or `analytics.enabled`.

```shell
ballin config
ballin config get update.cleanup
ballin config set update.cleanup false
ballin config reset
```

`ballin config` prints the full config, `get` prints one value, and `set` updates
an existing setting. Use `ballin help config` for usage, even if the config
file is missing or unreadable.

Use `ballin config reset` to recover a missing or malformed config file. This
restores defaults and replaces saved settings. If the file is missing, reset
creates one readable only by its owner. For read or save errors, check the config
file's permissions and its parent directory before retrying.

For custom config files, Ballin retains Unix permission bits and follows working
symlinks. Custom ACLs and ownership metadata are not copied. Replace hard-linked
configs with a regular file before saving. For a broken symlink, restore its target
or replace the link with a regular file.

## Node.js

Ballin requires Node.js 24.12 or newer to run its TypeScript directly with
[stable built-in type stripping](https://nodejs.org/api/typescript.html#type-stripping).
We recommend the latest Node.js long-term support (LTS) release.

[Quickstart](quickstart.md) offers [NVM](https://github.com/nvm-sh/nvm) and latest
LTS Node. With compatible existing Node, keeping your setup is the default.
A consented switch activates LTS and makes it the future default, retaining
older versions and installations. Global npm tools may need reinstalling under
the selected version. Other installation choices remain available through
[Node.js downloads](https://nodejs.org/en/download).

Installed commands use the `node` found on your shell `PATH`, so make sure new
terminal sessions use a supported Node.js version too.

Review optional NVM updates with `ballin setup`, or enable them with `ballin config set update.nvm true`.
`update.nvm` defaults to `false` and applies only to an existing nvm installation.
It runs `nvm install --lts`; it does not update nvm itself or migrate globally
installed npm packages to the new Node.js version. Other Node installations
remain managed by their existing installation method.

## Mac App Store apps

Install [`mas`](https://github.com/mas-cli/mas) with Homebrew to add Mac App
Store support:

```shell
brew install mas
```

When `mas` is available, `ballin update` updates installed App Store apps and
`ballin backup` includes the installed-app list in your backup. No configuration
setting is required.

## Private repository backups

Newly configured backups use private repositories owned by an individual account
on GitHub.com, GitHub Enterprise Server or a GHE.com tenant host, accessed through [GitHub CLI](https://cli.github.com/). Backup is
optional; declining it leaves a healthy maintenance-only installation and makes
no `gh` calls.

```shell
ballin backup setup [repository-name] [--hostname <host>]
```

Fresh setup asks for the host (default: `github.com`, unless supplied by flag),
offers create or reconnect, reviews one local sensitive-source choice,
and confirms before remote or linkage changes. The effective `gh` credential
can come from an environment token; Ballin shows the selected account and never
logs in, switches accounts, or expands scopes automatically. Read-only access
supports reconnect and recovery without granting write permission. See
[setup and recovery](installation.md#optional-backup-setup-and-reconnect).

`backup.repository` identifies the selected destination. Inventories and filtered
preferences form the fixed baseline. The `backup.includeSensitive` choice
(default: `false`) adds sensitive sources from the [maintained catalog](backup-sources.md),
including future supported additions. Destination and consent stay local and are
never recovered from backups. Changing consent affects future captures, not saved
files or history. Rerun `ballin backup setup` to validate your destination and
[review backup settings](installation.md#optional-backup-setup-and-reconnect),
or use `ballin setup` for general preference review.

When self-update starts with the current updater, a successful update links to
the source guide if definitions changed or could not be compared. The advisory
does not change consent.

To toggle sensitive sources in future backups:

```shell
ballin config set backup.includeSensitive true
ballin config set backup.includeSensitive false
```

Use `ballin setup` to review automatic backup during updates, defaulting to No
unless you have saved another choice. You can also change it directly:

```shell
ballin config set update.backup true
ballin config set update.backup false
```

Backups are stored in a private GitHub repository.
GitHub can access backups on GitHub.com or GHE.com; a GitHub Enterprise
Server hosting operator and site administrators may also have access. Anyone
with authorized repository access can read the contents.

Even when sensitive sources are excluded, the default-included inventory can
reveal identities, private or custom URLs, and paths; Ballin does not scan or
redact credentials.

GitHub determines the author and committer identities recorded for repository
backup commits. Ballin does not change your global Git identity settings. GitHub
keeps the repository history, so older backup revisions may remain there. Ballin
does not currently provide commands to browse that history, roll back to an
older revision, or restore a specific revision.

Use `ballin backup open` or `ballin backup read <file>` for read-only recovery,
and `ballin backup disconnect` to clear local linkage and disable automatic
backups. Use only one Mac to back up to a destination. Stop using the previous
Mac for backups before publishing from a replacement Mac. See
[conflicts](capabilities.md#backup-consistency-and-conflicts).

## Readiness checks

Use `ballin doctor` to check the managed environment. Maintenance-only Ballin
is healthy and does not invoke `gh`; configured backup failures affect overall
health. See [Supported capabilities](capabilities.md#ballin-doctor) for the
checks and their limitations.

```shell
ballin doctor
```

## Recovering Ballin preferences

Reconnect can recover supported portable Ballin preferences, and existing local
choices take precedence. Preference recovery changes later Ballin behavior; it
does not run maintenance, restore dotfiles, or reinstall packages. Other local
state is not recovered from the backup. The recoverable settings are
`update.cleanup`, `update.selfUpdate`, `update.softwareupdate`, `update.npm`, and
`update.nvm`. Your destination, sensitive-source choice, automatic-backup choice,
and analytics choice stay local.

Maintainers can find the export format and validation rules in
[Backup design](backup-design.md#portable-preferences).

## Analytics

Analytics are optional. The single local `analytics.enabled` setting covers
top-level command usage and outcomes, real backup outcomes, and automatic backup
and self-update outcomes during `ballin update`. Backups do not save or restore
this choice. See [Analytics](analytics.md) for controls, exact payloads, storage,
and retention.

## `ballin update` settings

Change a setting with `ballin config set update.<name> true` or
`ballin config set update.<name> false`.

`ballin update` validates these settings before running any integration. Missing
known settings use bundled defaults in memory for the current run and appear in
one warning. The config file remains unchanged, and this behavior does not
depend on self-update. Malformed JSON, invalid config structure, or known values
other than booleans and canonical `"true"` or `"false"` strings fail before any
integration runs. Later stages continue after ordinary child-command failures.

| Setting | Default | Behavior |
| --- | --- | --- |
| `update.cleanup` | `true` | Runs `brew cleanup` after the Homebrew refresh attempt and any package upgrade. |
| `update.selfUpdate` | `true` | Updates `ballin-scripts` when `ballin update` runs, then checks Ballin readiness if the update succeeds. |
| `update.backup` | `false` | Runs `ballin backup` to back up your development environment. Configure a destination with `ballin backup setup` before enabling it; an explicitly requested unconfigured backup stage fails with setup guidance. |
| `update.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `update.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `update.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |

### Interrupting updates

Ctrl-C that terminates Ballin stops the update invocation, so later stages,
including an enabled backup, do not run. Ballin does not offer a prompt to skip
an interrupted stage or resume the remaining steps. Terminating Ballin does not
undo completed changes or guarantee that every subprocess or macOS update
service has stopped or that temporary files have been cleaned up.

If only a child command is interrupted and Ballin remains running, later stages
continue.

Interrupting the private-backup access check during readiness after self-update
stops the invocation before the backup stage.

To run macOS updates separately, disable that stage in advance:

```shell
ballin config set update.softwareupdate false
```

This setting persists for future runs until you enable it again; it does not
skip a stage only for the current run or resume an interrupted update.
