# Ballin

*Back up your dotfiles and update your macOS development environment*

![Ballin README hero showing the Ballin identity and the line Back up dotfiles. Keep your tools current.](docs/assets/brand/readme-hero.png)

Ballin helps developers maintain repeatable, inspectable macOS
development environments. It snapshots shell and Git configuration, Homebrew
state, editor settings, and local tool inventories while automating routine
updates.

## What it does

- `ballin backup` snapshots local development-environment state to a configured
  private GitHub repository.
- `ballin update` runs configured maintenance tasks such as Homebrew upgrades,
  Node.js/npm updates, macOS and App Store updates, self-updates, and backups.

## Installation

The installer checks Git and Node.js, shows its plan, and asks before making a
fresh installation. It installs the maintenance commands first; backup is
optional, and a maintenance-only installation does not require Homebrew or
GitHub CLI. When configured, backups can run automatically with `ballin update`.

Run the [install script](https://github.com/JBallin/ballin-scripts/blob/main/install.sh):

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

Review the exact local effects, network interactions, partial-failure behavior,
and removal steps in [Installation and removal](docs/installation.md).

## Example output

`ballin update` output depends on installed tools and enabled integrations. This
example includes optional backups.

```shell
$ ballin update

==> Updating Homebrew packages

==> Cleaning up Homebrew packages

==> Checking Homebrew installation
Your system is ready to brew.

==> Updating App Store apps

==> Installing macOS updates

==> Backing up development environment
✔ zprofile
✔ zshrc
...
✔ vs_settings
✔ mas
```

## New Mac setup

On a new Mac, install Ballin for maintenance, then optionally create or reconnect to a
private backup repository with `ballin backup setup`. Reconnecting to an existing backup can recover
supported Ballin preferences; existing local choices take precedence. See
[preference recovery](docs/optional-capabilities.md#recovering-ballin-preferences)
for details. Retire the prior writer before using a replacement Mac to publish.

Use snapshots as a rebuild reference. Ballin does not automatically apply saved
dotfiles or install saved packages; it is not a full disk backup or one-command
restore system.

## Commands

| Command | Purpose |
| --- | --- |
| `ballin` | Shows available commands and common usage. |
| `ballin doctor` | Checks the managed environment. |
| `ballin backup setup [repository-name]` | Creates, reconnects to, or revalidates a private backup repository. |
| `ballin backup` | Updates snapshots in the configured backup. |
| `ballin backup open` | Opens the configured backup. |
| `ballin backup disconnect` | Clears local linkage and disables automatic backups. |
| `ballin backup read <file>` | Prints a backed-up file from the destination. |
| `ballin update` | Runs configured update tasks. |
| `ballin config` | Reads and updates local Ballin settings. |
| `ballin self-update` | Updates the local checkout and refreshes installed commands and configuration. |
| `ballin uninstall` | Removes installed command shims and the local checkout. |

## Privacy and security

New backups use private GitHub.com repositories. GitHub and authorized accounts
or tokens can read their contents; possession of the URL alone does not grant
access. Existing configured Gists remain supported until migration is available;
secret Gists are unlisted and readable by anyone with the URL or ID.

Repository backups include fixed inventories and filtered Ballin preferences.
One default-off local choice adds raw configuration and pipx metadata. Even the
baseline can contain private tools, identities, paths, or URLs. Ballin does not
scan or redact credentials. Review the [sources and sensitivity](docs/backup-sources.md)
before opting in. GitHub controls commit author and committer attribution.

## Documentation

See the [documentation](docs/README.md) for installation, backup sensitivity,
Node.js setup, update settings, optional integrations, and managed capabilities.
