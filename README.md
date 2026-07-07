# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps you recreate and maintain a macOS development environment
with minimal manual setup. It stores a private backup of state such as shell
configuration, Git configuration, Homebrew package lists, editor settings, and
local tool state, then automates routine updates.

It is built for people who want a repeatable macOS development environment with
low-friction updates.

## Quick start

Install `ballin-scripts`, then run the first health check and backup:

```shell
ballin doctor
ballin backup
ballin update
```

`ballin doctor` checks whether the Ballin-managed environment is healthy.
Run `ballin backup` once to create the initial snapshot, then use
`ballin update` for ongoing maintenance.

## What this is

`ballin-scripts` is a backup and update toolkit for repeatable macOS
development environments. It is not a full disk backup, a secrets manager, or a
complete one-command machine restore system.

## Backup and update behavior

The tools split backup from broader system updates:

- `ballin backup` reads local development-environment state and uploads changed
  snapshots to the configured private Gist.
- `ballin update` runs update tasks such as Homebrew upgrades, optional Node.js/npm
  updates, optional macOS and App Store updates, optional `ballin-scripts`
  updates, and optional backups.
- Installation adds the command shims to your shell path and configures the
  private Gist used by backups.

Optional update behavior is controlled through `ballin config`.

## Fresh Mac setup

On a new Mac, install `ballin-scripts` and let the installer create or adopt the
private backup Gist used by `ballin backup`. If you adopt an existing backup,
use `ballin backup open` or `ballin backup read <file>` to inspect saved
snapshots and use them as a rebuild reference.

## Privacy and security

Backups are stored in the configured private GitHub Gist. Treat them as
developer-environment metadata: paths, usernames, package and tool choices,
editor settings, and local configuration can reveal details about your setup.
Review snapshots before sharing a Gist or making it public.

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

See the [documentation index](docs/README.md) for Node.js setup, update
settings, optional integrations, and managed capabilities.

## Example output

With optional integrations enabled, `ballin update` updates the machine and can
finish by backing up the development environment. Output varies by installed
tools and settings.

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

## Usage

### Update with `ballin update`

`ballin update` automates common update tasks for a macOS development machine,
including Homebrew upgrades, App Store and macOS updates, `ballin-scripts`
updates, optional Node.js/npm updates, and optional backups.

```shell
ballin update
```

Most optional behavior is controlled through `ballin config`; see the
[optional capabilities guide](docs/optional-capabilities.md) for update
settings, and the [supported capabilities reference](docs/capabilities.md) for
the full list of update integrations.

### Back up with `ballin backup`

`ballin backup` uploads changed snapshots to a configured private Gist. It can
include local files and tool state when the supporting tools are installed.

See the [supported capabilities reference](docs/capabilities.md) for the full
list of backup snapshots.

```shell
ballin backup
```

Backup status markers:

- `✚` newly saved or newly meaningful snapshot
- `✎` existing snapshot content changed
- `✖︎` existing snapshot became empty
- `✔` unchanged non-empty snapshot
- unchanged empty snapshots do not print a line

Open the configured backup Gist:

```shell
ballin backup open
```

Read one backed-up file from the Gist:

```shell
ballin backup read zshrc.sh
```

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin update` | Updates Homebrew, macOS, App Store apps, optional Node.js/npm tools, `ballin-scripts`, and optional backups. |
| `ballin backup` | Backs up dotfiles, editor settings, package lists, and tool state to a private Gist. |
| `ballin doctor` | Checks whether the Ballin-managed environment is healthy. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local `ballin-scripts` checkout and refreshes installed commands and configuration. |
| `ballin uninstall` | Removes installed command symlinks and the local checkout. |
