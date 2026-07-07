# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps developers keep macOS setup repeatable, inspectable, and
easy to maintain. It snapshots shell and Git configuration, Homebrew package
lists, editor settings, and local tool state, then automates routine updates.

## What it does

- `ballin backup` snapshots local development-environment state to a configured
  secret GitHub Gist.
- `ballin update` runs common maintenance tasks such as Homebrew upgrades,
  optional Node.js/npm updates, optional macOS and App Store updates, optional
  `ballin-scripts` updates, and optional backups.

## Installation

The installer adds command shims, configures the backup Gist, and guides you
through missing setup. For the smoothest first run, use macOS with Node.js LTS,
Homebrew, and an authenticated GitHub CLI.

Run the [install script](https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh):

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

Then verify setup and create the initial backup:

```shell
ballin doctor
ballin backup
```

`ballin doctor` checks the managed environment. `ballin backup` creates the
initial snapshot. Use `ballin update` for ongoing maintenance.

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

On a new Mac, install `ballin-scripts` and create or adopt the backup Gist.
Inspect existing snapshots with `ballin backup open` or
`ballin backup read <file>`, then use them as a rebuild reference.

`ballin-scripts` makes rebuilds more repeatable and auditable, but it is not a
full disk backup or one-command restore system.

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin backup` | Updates snapshots in the configured secret Gist. |
| `ballin backup open` | Opens the configured backup Gist. |
| `ballin backup read <file>` | Prints a backed-up file from the Gist. |
| `ballin update` | Runs configured update tasks. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands/configuration. |
| `ballin uninstall` | Removes installed command shims and the local checkout. |

## Documentation

See the [documentation index](docs/README.md) for Node.js setup, update settings,
optional integrations, and managed capabilities.

## Privacy and security

Backups are stored in a configured secret GitHub Gist. Secret Gists are
unlisted, but anyone with the URL can view them. Treat the Gist URL and
snapshots as sensitive: paths, usernames, package choices, editor settings, and
local configuration can reveal details about your setup.

`ballin-scripts` is not a secrets manager. Review snapshots before sharing the
Gist URL or making the Gist public.
