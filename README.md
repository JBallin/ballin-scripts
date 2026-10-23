# Ballin

*Back up your dotfiles and update your macOS development environment*

![Ballin README hero showing the Ballin identity and the line Back up dotfiles. Keep your tools current.](docs/assets/brand/readme-hero.png)

Ballin backs up selected development-environment state and automates routine
updates for macOS developer tools. Use it to keep the Mac you already work on
current and save a record of its tools and configuration for a later rebuild.

`ballin update` runs maintenance tasks for installed tools and enabled
integrations. Optional backups save tool inventories and supported Ballin
preferences in a private GitHub repository; a separate opt-in adds supported
shell, Git, editor, Codex, and Claude Code configuration. You can use maintenance
alone without configuring backups.

See [Choosing Ballin](docs/choosing-ballin.md) for when it fits and how to use it
alongside other tools.

## Installation

> [!TIP]
> Want guided setup? The interactive [Quickstart](docs/quickstart.md) helps install missing prerequisites. 🚀

Start with Git and [Node.js 24.12 or newer](docs/optional-capabilities.md#nodejs)
on your `PATH`. Homebrew is optional; backups require
[GitHub CLI](https://cli.github.com/) authenticated to GitHub.com.

Open Terminal and run the [install script](https://github.com/JBallin/ballin-scripts/blob/main/install.sh):

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

Backups are optional; you can configure them later with `ballin backup setup`.

See [Installation and removal](docs/installation.md) for setup details and
troubleshooting.

## Example output

Run `ballin update` for routine maintenance and optional automatic backups. This
example shows a fully configured run.

```text
$ ballin update
==> Updating Homebrew
...
==> Updating Homebrew packages
...
==> Cleaning up Homebrew packages
...
==> Checking Homebrew installation
...
==> Updating Node.js LTS
...
==> Updating global npm packages
...
==> Updating App Store apps
...
==> Installing macOS updates
...
==> Updating Ballin
...
==> Checking Ballin readiness
...
==> Backing up development environment
Last successful backup: Dec 31, 2025, 4:00:00 PM GMT-08:00
✔ ballin_config
✔ bash_completions
✔ Brewfile
...
✎ zshrc
View changes: https://github.com/example-user/ballin-backups/commit/0123456789abcdef0123456789abcdef01234567
```

## Using saved state on another Mac

Saved snapshots of your tools and configuration give you a reference when
[setting up another Mac](docs/new-mac.md).

## Commands

For command syntax and options, use `--help` on a top-level command, such as
`ballin backup --help`.

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| [`ballin doctor`](docs/capabilities.md#ballin-doctor) | Checks the managed environment. |
| [`ballin backup setup [repository-name]`](docs/installation.md#optional-backup-setup-and-reconnect) | Creates, reconnects to, or revalidates a private backup repository. |
| [`ballin backup`](docs/capabilities.md#ballin-backup) | Updates snapshots in the configured backup. |
| [`ballin backup open`](docs/installation.md#inspect-saved-backups) | Opens the configured backup. |
| [`ballin backup disconnect`](docs/installation.md#disconnect) | Disconnects this Mac from its backup and disables automatic backups. |
| [`ballin backup list`](docs/installation.md#inspect-saved-backups) | Lists supported snapshots saved in the configured backup. |
| [`ballin backup read <snapshot>`](docs/installation.md#inspect-saved-backups) | Prints one supported snapshot from the destination. |
| [`ballin backup read <snapshot> --list`](docs/installation.md#inspect-saved-backups) | Lists file paths in a saved bundle snapshot. |
| [`ballin backup read <snapshot> --file <path>`](docs/installation.md#inspect-saved-backups) | Prints one file's contents from a bundle snapshot. |
| [`ballin update`](docs/capabilities.md#ballin-update) | Runs configured update tasks. |
| [`ballin setup`](docs/optional-capabilities.md#guided-preference-review) | Guides you through local onboarding preferences again. |
| [`ballin config`](docs/optional-capabilities.md#working-with-settings) | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands and configuration. |
| [`ballin uninstall`](docs/installation.md#uninstall) | Removes installed command shims and the local checkout. |

## Privacy and security

Backups are stored in a private GitHub repository. Default backup sources may
contain private information; more sensitive sources require opt-in. Ballin does
not scan or redact secrets. Review
[Backup sources and sensitivity](docs/backup-sources.md) before choosing what to include.
[Usage analytics](docs/analytics.md) are optional and disabled by default.

## Further reading

See the [documentation index](docs/README.md) for user and maintainer guides,
including [supported capabilities](docs/capabilities.md) and
[optional tools and settings](docs/optional-capabilities.md).
