# Getting the most out of Ballin

*Tips for existing users who want to keep their tools easier to maintain.*

## Give each tool a clear home

Use a package manager where it fits your workflow, and keep track of apps that
use their own updater. Ballin can call supported managers together, which reduces
the number of separate maintenance commands you need to remember. It does not
update every app on your Mac.

- **Node.js:** [nvm](https://github.com/nvm-sh/nvm) lets you switch Node.js versions
  and use project-specific `.nvmrc` files. To let `ballin update` install the latest
  LTS release through an existing nvm installation, enable
  `ballin config set update.nvm true`. This is off by default; it does not update
  nvm itself or migrate global npm packages. See [Node.js setup and tradeoffs](optional-capabilities.md#nodejs).
- **Mac App Store apps:** Install [`mas`](https://github.com/mas-cli/mas) if you want
  Ballin to run `mas upgrade` during `ballin update`. Ballin discovers `mas` on
  `PATH`; no Ballin setting is needed. App Store account and app eligibility
  requirements still apply.
- **Other apps:** Consider [Homebrew casks](https://docs.brew.sh/Cask-Cookbook)
  for apps available through Homebrew. Ballin runs ordinary `brew upgrade` when
  Homebrew is on `PATH`. Homebrew's [upgrade rules](https://docs.brew.sh/FAQ#how-does-brew-upgrade-handle-apps-that-update-themselves)
  still apply: some casks, including apps that update themselves, are skipped by
  default. Installing a manager does not put all existing apps under its control.

## Make maintenance a habit

Make `ballin update` a regular habit at a convenient maintenance time. Save your
work first: Homebrew cask updates may quit running apps, and macOS updates may
require a restart. Leave time to review output and address failures. Ballin
does not install a recurring schedule for you. See [Supported capabilities](capabilities.md#ballin-update)
for the integrations and [update settings](optional-capabilities.md#ballin-update-settings)
to choose optional stages.

Before updating, [`brew outdated`](https://docs.brew.sh/Manpage#outdated-options-formulacask-)
lists outdated Homebrew packages. This previews
only Homebrew's view of available updates, not the full `ballin update` run.

## Include backups in your update routine

Backup during updates is off by default (`update.backup=false`). After
[setting up a backup destination](installation.md#optional-backup-setup-and-reconnect),
enable it with:

```shell
ballin config set update.backup true
```

Ballin then runs a backup as the final stage of `ballin update`, after the update
stages. It does not create a backup before upgrades or schedule updates for you.

If you use backups, review [what they contain](backup-sources.md) and inspect
saved snapshots with `ballin backup list` and `ballin backup read`. Package
inventories can help you see what was installed; they do not automatically
reinstall apps or restore your Mac.
