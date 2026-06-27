# Ballin Scripts

*Back up your dotfiles and update your macOS development environment.*

`ballin-scripts` is a personal macOS CLI for making a development machine easy
to rebuild and simple to keep current. It backs up dotfiles, editor settings,
Homebrew state, npm globals, and related configuration to a private Gist, then
runs the update tasks that keep the machine up to date.

Core workflow:

- `up` updates the local development environment.
- `gu` snapshots the configuration needed to recreate it.

## Installation

Run the [install script](install.sh) using cURL:

```shell
bash <(curl -s https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

See the [optional capabilities guide](docs/optional-capabilities.md) for Node.js
setup, update settings, and optional integrations.

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

`up` runs the update tasks that are useful on a macOS development machine:
Homebrew upgrades and cleanup, Homebrew health checks, App Store updates through
`mas`, macOS updates, `ballin-scripts` updates, optional Node.js LTS updates,
optional global npm package updates, and optional `gu` backups.

```shell
up
```

Most optional behavior is controlled through `ballin_config`:

```shell
ballin_config set up.gu true
ballin_config set up.npm false
```

See the [optional capabilities guide](docs/optional-capabilities.md) for the
full list of update settings and optional integrations.

### Back up with `gu`

`gu` uploads changed snapshots to a configured private Gist. It can include
shell dotfiles, Git config, Homebrew formulae and casks, global npm packages,
nvm settings, editor settings, editor extensions, bash completions, and Mac App
Store apps when the supporting tools are installed.

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
| `ballin_update` | Pulls the latest `ballin-scripts` changes and reruns installation. |
| `ballin_uninstall` | Removes installed command symlinks and the local checkout. |
