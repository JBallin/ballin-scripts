# Ballin Scripts

*Back up your dotfiles and keep your macOS development environment current.*

`ballin-scripts` is a small personal toolkit for preserving the parts of a
development setup that are easy to forget and annoying to rebuild. It backs up
dotfiles, editor settings, package lists, and other local development state to a
private Gist, then helps keep the surrounding software up to date.

Suggested GitHub About tagline:

> Back up your dotfiles and update your macOS development environment.

## Installation

Run the [install script](install.sh) using cURL:

```shell
bash <(curl -s https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

See the [optional capabilities guide](docs/optional-capabilities.md) for
additional setup and configuration.

## What it does

### Back up your setup with `gu`

`gu` snapshots the local files and tool state that describe your development
environment, then uploads only changed snapshots to a configured private Gist.
It can include shell dotfiles, Git config, Homebrew formulae and casks, global
npm packages, nvm settings, editor settings, editor extensions, bash
completions, and Mac App Store apps when the supporting tools are installed.

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

RELATED: [My Sweet Config](https://github.com/JBallin/sweet-config) visualizes
the setup captured by `gu`.

### Update your environment with `up`

`up` runs the update tasks that are useful on a macOS development machine. It
updates Homebrew packages, optionally cleans them up, checks Homebrew health,
updates App Store apps when `mas` is installed, installs macOS updates, updates
`ballin-scripts`, and can opt into Node.js LTS, global npm package, and `gu`
backup steps.

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

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `gu` | Backs up dotfiles, editor settings, package lists, and tool state to a private Gist. |
| `up` | Updates Homebrew, macOS, App Store apps, Node.js/npm options, `ballin-scripts`, and optional backups. |
| `ballin_config` | Reads and updates local `ballin-scripts` settings. |
| `ballin_update` | Pulls the latest `ballin-scripts` changes and reruns installation. |
| `ballin_uninstall` | Removes installed command symlinks and the local checkout. |
