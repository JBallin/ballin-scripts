# Ballin

*Back up your dotfiles and update your macOS development environment*

![Ballin README hero showing the Ballin identity and the line Back up dotfiles. Keep your tools current.](docs/assets/brand/readme-hero.png)

Ballin helps developers maintain repeatable, inspectable macOS
development environments. It snapshots shell and Git configuration, Homebrew
state, editor settings, and local tool inventories while automating routine
updates.

## What it does

- `ballin backup` snapshots local development-environment state to a configured
  secret GitHub Gist.
- `ballin update` runs configured maintenance tasks such as Homebrew upgrades,
  Node.js/npm updates, macOS and App Store updates, self-updates, and backups.

## Installation

The installer checks Git and Node.js, shows its plan, and asks before making a
fresh installation. It installs the maintenance commands first; Gist backup is
an optional later step. Maintenance-only installation does not require Homebrew
or GitHub CLI; Gist backup setup requires an authenticated GitHub CLI.

Run the [install script](https://github.com/JBallin/ballin-scripts/blob/main/install.sh):

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

Review the exact local effects, network interactions, partial-failure behavior,
and removal steps in [Installation and removal](docs/installation.md).

## Example output

`ballin update` output depends on installed tools and enabled integrations.

```shell
$ ballin update

==> Updating Homebrew packages

==> Cleaning up Homebrew packages

==> Checking Homebrew installation
Your system is ready to brew.

==> Updating App Store apps

==> Installing macOS updates
```

## New Mac setup

On a new Mac, install Ballin for maintenance, then optionally create or adopt a
backup Gist with `ballin backup setup`. Use existing snapshots as a rebuild
reference.

Ballin makes rebuilds more repeatable and auditable, but it is not a
full disk backup or one-command restore system.

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin backup setup` | Creates or adopts an optional backup Gist. |
| `ballin backup` | Updates snapshots in the configured backup Gist. |
| `ballin backup open` | Opens the configured backup Gist. |
| `ballin backup read <file>` | Prints a backed-up file from the Gist. |
| `ballin update` | Runs configured update tasks. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands and configuration. |
| `ballin uninstall` | Removes installed command shims and the local checkout. |

## Privacy and security

Backups are stored in a configured secret GitHub Gist. Secret Gists are
unlisted, but anyone with the URL or ID can view them. Treat the destination and
snapshots as sensitive.

Ballin uses an explicit source allowlist, but allowed files can contain
arbitrary user-added credentials, private URLs, paths, and commands. Ballin is
not a secrets manager and does not scan or redact allowed content. Review the
[source and sensitivity audit](docs/backup-sources.md) before enabling backup
or sharing the Gist.

Secret Gists remain Ballin's current backup storage. [#254](https://github.com/JBallin/ballin-scripts/issues/254)
tracks the longer-term evaluation of more secure storage options; this project
does not yet implement that redesign.

## Documentation

See the [documentation](docs/README.md) for installation, backup sensitivity,
Node.js setup, update settings, optional integrations, and managed capabilities.
