# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps you recreate and maintain a macOS development environment
with minimal manual setup. It backs up the files, package lists, editor settings,
and local configuration that define your setup, then automates routine updates.

It is built for people who want a repeatable macOS development environment with
low-friction updates.

Core commands:

- `ballin update` updates the development environment.
- `ballin backup` snapshots the development environment to a private Gist.

Shortcuts: `up` aliases `ballin update`; `gu` aliases `ballin backup`.

## What it manages

`ballin-scripts` backs up development-environment state that is easy to lose
when moving between Macs or rebuilding a development machine:

- shell startup files and common editor config files
- Git config and global ignore files
- Homebrew formulae, casks, services, and Brewfile output
- global npm packages and Node.js version preference
- VS Code and VS Code Insiders settings, keybindings, and extensions
- optional Mac App Store app inventory through `mas`
- local `ballin-scripts` configuration

See the [supported capabilities reference](docs/capabilities.md) for the exact
snapshot files and update integrations.

## Backup and update behavior

The tools split backup from broader system updates:

- `ballin backup` reads local development-environment state and uploads changed
  snapshots to the configured private Gist.
- `ballin update` runs update tasks such as Homebrew upgrades, optional Node.js/npm
  updates, optional macOS and App Store updates, optional `ballin-scripts`
  updates, and optional backups.
- Installation adds the command shims to your shell path and configures the
  private Gist used by backups.

Optional update behavior is controlled through `ballin config`; see the
[optional capabilities guide](docs/optional-capabilities.md) for the defaults
and tradeoffs.

## Fresh Mac setup

On a new Mac, install `ballin-scripts` and let the installer create or adopt the
private backup Gist used by `ballin backup`. Future snapshots provide the
reference for recreating shell files, Git settings, package lists, editor
settings, and other development-environment state.

This is currently a backup and update toolkit, not a full one-command
machine restore system. The backed-up snapshots make rebuilds more repeatable
and auditable.

## Installation

Install with:

```shell
bash <(curl -s https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

See the [documentation index](docs/README.md) for Node.js setup, update
settings, optional integrations, and the full list of managed capabilities.

## Example output

With optional integrations enabled, `ballin update` updates the machine and
finishes by backing up the development environment. Output varies by installed
tools and settings.

```shell
$ ballin update

==> Updating Homebrew packages

==> Cleaning up Homebrew packages

==> Checking Homebrew installation
Your system is ready to brew.

==> Updating Node.js LTS
Installing latest LTS version.
v24.18.0 is already installed.
Now using node v24.18.0 (npm v11.16.0)

==> Updating App Store apps

==> Installing macOS updates
Software Update Tool

Finding available software
No updates are available.

==> Backing up development environment
✔ zprofile
✔ zshrc
✔ bash_completions
✔ brew_list
✔ brew_leaves
✔ brew_cask
✔ Brewfile
✔ gitconfig
✔ npm_global
✔ vs_settings
✔ vs_extensions
✔ ballin_config
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

Most optional behavior is controlled through `ballin config`:

```shell
ballin config set up.gu true
ballin config set up.npm false
```

See the [optional capabilities guide](docs/optional-capabilities.md) for update
settings, and the [supported capabilities reference](docs/capabilities.md) for
the full list of update integrations.

### Back up with `ballin backup`

`ballin backup` uploads changed snapshots to a configured private Gist. It can
include shell dotfiles, Git config, Homebrew formulae and casks, global npm
packages, nvm settings, editor settings, editor extensions, bash completions,
and Mac App Store apps when the supporting tools are installed.

See the [supported capabilities reference](docs/capabilities.md) for the full
list of backup snapshots.

```shell
ballin backup
```

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

The existing utility commands `ballin_config`, `ballin_update`, and
`ballin_uninstall` remain supported for direct use.
