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

Start with Git and Node.js 24.12 or newer on your `PATH`. Homebrew is optional;
backups also require [GitHub CLI](https://cli.github.com/) authenticated to your
personal GitHub.com account. See [Node.js setup](docs/optional-capabilities.md#nodejs)
if you need a supported runtime.

For setup from one pasted command, see [your first backup](docs/quickstart.md).

Review the [install script](https://github.com/JBallin/ballin-scripts/blob/main/install.sh),
then run:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

The installer shows its plan and asks before a fresh installation. It offers
optional usage analytics (disabled by default), shell completion, and backup
setup. You can skip backups or configure them later with `ballin backup setup`.
Installation does not run updates or capture snapshots. For a new backup
destination, run `ballin backup` for your first capture; for an existing backup,
see [using saved state on another Mac](#using-saved-state-on-another-mac).

Review [Installation and removal](docs/installation.md) for local effects,
network interactions, backup authentication, troubleshooting, and removal.

## Example output

Use `ballin update` for everyday maintenance. It runs stages for installed tools
and enabled integrations, checks readiness after a successful Ballin self-update,
and backs up selected state at the end when automatic backups are enabled.

This example shows a fully configured run.

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

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin backup setup [repository-name]` | Creates, reconnects to, or revalidates a private backup repository. |
| `ballin backup` | Updates snapshots in the configured backup. |
| `ballin backup open` | Opens the configured backup. |
| `ballin backup disconnect` | Disconnects this Mac from its backup and disables automatic backups. |
| `ballin backup list` | Lists supported snapshots saved in the configured backup. |
| `ballin backup read <snapshot>` | Prints one supported snapshot from the destination. |
| `ballin backup read <snapshot> --list` | Lists file paths in a saved bundle snapshot. |
| `ballin backup read <snapshot> --file <path>` | Prints one file's contents from a bundle snapshot. |
| `ballin update` | Runs configured update tasks. |
| `ballin setup` | Guides you through [local onboarding preferences](docs/optional-capabilities.md#guided-preference-review) again. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands and configuration. |
| `ballin uninstall` | Removes installed command shims and the local checkout. |

## Privacy and security

Backups are stored in a private GitHub repository. GitHub and anyone authorized
to access the repository can read its contents.

Inventories and filtered Ballin preferences are included by default. Sensitive
sources, including raw configuration and pipx metadata, require one local opt-in
covering current and future supported sources. Even default-included inventories
can contain private tools, identities, paths, or URLs. Ballin does not scan or
redact secrets. Review [Backup sources and sensitivity](docs/backup-sources.md)
before choosing what to include. Changing that choice does not remove saved
files or repository history.

[Usage analytics](docs/analytics.md) are a separate local choice, disabled by
default and never saved or recovered through backups.

## Further reading

See the [documentation index](docs/README.md) for user and maintainer guides,
including [supported capabilities](docs/capabilities.md) and
[optional tools and settings](docs/optional-capabilities.md).
