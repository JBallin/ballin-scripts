# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps developers maintain and recreate macOS development
environments with minimal manual setup. It snapshots shell and Git
configuration, Homebrew package lists, editor settings, and local tool state,
then automates routine updates.

## Scope

`ballin-scripts` is a backup and update toolkit for repeatable macOS
development environments. It is not a full disk backup, a secrets manager, or a
one-command machine restore system.

- `ballin backup` snapshots local development-environment state to the
  configured secret GitHub Gist.
- `ballin update` runs update tasks such as Homebrew upgrades, optional Node.js/npm
  updates, optional macOS and App Store updates, optional `ballin-scripts`
  updates, and optional backups.
- The installer adds command shims to your shell path and configures the backup
  Gist.

## Privacy and security

Backups are stored in a configured secret GitHub Gist. Secret Gists are
unlisted, but anyone with the URL can view them. Treat both the Gist URL and
backup snapshots as sensitive: paths, usernames, package choices, editor
settings, and local configuration can reveal details about your setup.

## Installation

The installer is interactive and guides you through missing setup. For the
smoothest first run, use macOS with current Node.js LTS, authenticated GitHub
CLI, and Homebrew available.

Install with:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

To inspect the installer first:

```shell
curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh -o /tmp/ballin-install.sh
less /tmp/ballin-install.sh
bash /tmp/ballin-install.sh
```

After installation:

```shell
ballin doctor
ballin backup
ballin update
```

`ballin doctor` checks the managed environment. `ballin backup` creates the
initial snapshot. `ballin update` handles ongoing maintenance.

## Fresh Mac setup

On a new Mac, install `ballin-scripts` and create or adopt the backup Gist. If
you adopt an existing backup, inspect saved snapshots with `ballin backup open`
or `ballin backup read <file>` and use them as a rebuild reference.

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
...

==> Backing up development environment
✔ zprofile
✔ zshrc
...
✔ vs_settings
✔ mas
```

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin update` | Runs configured update tasks. |
| `ballin backup` | Updates backup snapshots in the configured secret Gist. |
| `ballin backup open` | Opens the configured backup Gist. |
| `ballin backup read <file>` | Prints one backed-up file from the Gist. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands and configuration. |
| `ballin uninstall` | Removes installed command symlinks and the local checkout. |

## Documentation

See the [documentation index](docs/README.md) for Node.js setup, update
settings, optional integrations, and managed capabilities.
