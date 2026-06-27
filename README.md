# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` helps you recreate and maintain a macOS development environment
with minimal manual setup. It backs up dotfiles, editor settings, Homebrew
state, npm globals, and related configuration to a private Gist, then automates
routine updates.

It is built for people who want their Mac setup to be repeatable: the files and
package lists that define the environment are captured in one place, and the
routine update path is available as a single command.

Core commands:

- `up` updates the development environment.
- `gu` snapshots it to a private Gist.

## What it manages

`ballin-scripts` focuses on the state that is easy to lose when moving between
Macs or rebuilding a development machine:

- shell startup files and common editor config files
- Git config and global ignore files
- Homebrew formulae, casks, services, and Brewfile output
- global npm packages and Node.js version preference
- VS Code and VS Code Insiders settings, keybindings, and extensions
- optional Mac App Store app inventory through `mas`
- local `ballin-scripts` configuration

See the [supported capabilities reference](docs/capabilities.md) for the exact
snapshot files and update integrations.

## What it changes

The tools split backup from broader system maintenance:

- `gu` reads local development-environment state and uploads changed snapshots
  to the configured private Gist.
- `up` runs maintenance tasks such as Homebrew upgrades, optional Node.js/npm
  updates, optional macOS and App Store updates, optional `ballin-scripts`
  updates, and optional `gu` backups.
- Installation adds the command shims to your shell path and configures the
  private Gist used by `gu`.

Optional update behavior is controlled through `ballin_config`; see the
[optional capabilities guide](docs/optional-capabilities.md) for the defaults
and tradeoffs.

## Fresh machine story

On a new Mac, install `ballin-scripts` and point it at an existing backup Gist
when prompted. The installer can adopt that Gist and restore saved
`ballin_config` values, while the Gist snapshots provide the reference for
recreating shell files, Git settings, package lists, editor settings, and other
development-environment state.

This is currently a backup and maintenance toolkit, not a full one-command
machine restore system. The backed-up snapshots are meant to make rebuilds more
repeatable and auditable as the project grows toward a broader shared-tool
workflow.

## Project status

`ballin-scripts` started as a personal macOS setup tool and is being shaped into
a reusable development-environment toolkit. The current focus is making the
backup, update, and rebuild story clear before broadening the public workflow.

## Installation

Install with:

```shell
bash <(curl -s https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

See the [documentation index](docs/README.md) for Node.js setup, update
settings, optional integrations, and the full list of managed capabilities.

## Example output

With optional integrations enabled, `up` updates the machine and finishes by
backing up the development environment. Output varies by installed tools and
settings.

```shell
$ up

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

### Update with `up`

`up` automates common maintenance tasks for a macOS development machine,
including Homebrew maintenance, App Store and macOS updates, `ballin-scripts`
updates, optional Node.js/npm updates, and optional `gu` backups.

```shell
up
```

Most optional behavior is controlled through `ballin_config`:

```shell
ballin_config set up.gu true
ballin_config set up.npm false
```

See the [optional capabilities guide](docs/optional-capabilities.md) for update
settings, and the [supported capabilities reference](docs/capabilities.md) for
the full list of update integrations.

### Back up with `gu`

`gu` uploads changed snapshots to a configured private Gist. It can include
shell dotfiles, Git config, Homebrew formulae and casks, global npm packages,
nvm settings, editor settings, editor extensions, bash completions, and Mac App
Store apps when the supporting tools are installed.

See the [supported capabilities reference](docs/capabilities.md) for the full
list of backup snapshots.

```shell
gu
```

Open the configured backup Gist:

```shell
gu open
```

Read one backed-up file from the Gist:

```shell
gu read zshrc.sh
```

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `up` | Updates Homebrew, macOS, App Store apps, optional Node.js/npm tools, `ballin-scripts`, and optional backups. |
| `gu` | Backs up dotfiles, editor settings, package lists, and tool state to a private Gist. |
| `ballin_config` | Reads and updates local `ballin-scripts` settings. |
| `ballin_update` | Pulls the latest `ballin-scripts` changes and reruns the installer. |
| `ballin_uninstall` | Removes installed command symlinks and the local checkout. |
