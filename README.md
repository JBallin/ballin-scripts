# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps developers maintain and recreate macOS development
environments with minimal manual setup. It snapshots shell and Git
configuration, Homebrew package lists, editor settings, and local tool state,
then automates routine updates.

It is designed for developers who want their Mac setup to be repeatable,
inspectable, and easy to keep current.

## What it does

- `ballin backup` snapshots local development-environment state to a configured
  secret GitHub Gist.
- `ballin update` runs common maintenance tasks such as Homebrew upgrades,
  optional Node.js/npm updates, optional macOS and App Store updates, optional
  `ballin-scripts` updates, and optional backups.
- The installer adds command shims to your shell path and configures the backup
  Gist.

## Installation

The installer is interactive and guides you through missing setup. For the
smoothest first run, use macOS with Node.js LTS, Homebrew, and an authenticated
GitHub CLI.

Install with:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

Inspect first:

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

## Fresh Mac setup

On a new Mac, install `ballin-scripts` and create or adopt the backup Gist. If
you adopt an existing backup, inspect saved snapshots with `ballin backup open`
or `ballin backup read <file>` and use them as a rebuild reference.

`ballin-scripts` makes rebuilds more repeatable and auditable, but it is not a
full disk backup or one-command machine restore system.

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin backup` | Updates backup snapshots in the configured secret Gist. |
| `ballin backup open` | Opens the configured backup Gist. |
| `ballin backup read <file>` | Prints one backed-up file from the Gist. |
| `ballin update` | Runs configured update tasks. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands/configuration. |
| `ballin uninstall` | Removes installed command shims and the local checkout. |

## Documentation

See the [documentation index](docs/README.md) for Node.js setup, update settings,
optional integrations, and managed capabilities.

## Privacy and security

Backups are stored in a configured secret GitHub Gist. Secret Gists are
unlisted, but anyone with the URL can view them. Treat the Gist URL and backup
snapshots as sensitive: paths, usernames, package choices, editor settings, and
local configuration can reveal details about your setup.

`ballin-scripts` is not a secrets manager. Review snapshots before sharing the
Gist URL or making the Gist public.
