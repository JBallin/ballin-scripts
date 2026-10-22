# Getting the most out of Ballin

*Tips for existing users who want to keep their tools easier to maintain.*

## Give each tool a clear home

Use supported package managers to keep more of your tools up to date through
`ballin update`. Keep track of apps that use their own updater; Ballin does not
update every app on your Mac.

- **Homebrew casks:** Consider [Homebrew casks](https://docs.brew.sh/Cask-Cookbook)
  for apps available through Homebrew. Ballin runs ordinary `brew upgrade` when
  Homebrew is on `PATH`. Homebrew's [upgrade rules](https://docs.brew.sh/FAQ#how-does-brew-upgrade-handle-apps-that-update-themselves)
  still apply: some casks, including apps that update themselves, are skipped by
  default. Installing Homebrew does not automatically make your existing apps
  Homebrew-managed.
- **Mac App Store apps:** Install [`mas`](https://github.com/mas-cli/mas) if you want
  Ballin to run `mas upgrade` during `ballin update`. Ballin discovers `mas` on
  `PATH`; no Ballin setting is needed. App Store account and app eligibility
  requirements still apply.
- **Node.js:** [nvm](https://github.com/nvm-sh/nvm) lets you switch Node.js versions
  and use project-specific `.nvmrc` files. To let `ballin update` install the latest
  LTS release through an existing nvm installation, enable
  `ballin config set update.nvm true`. This is off by default; it does not update
  nvm itself or migrate global npm packages. See [Node.js setup and tradeoffs](optional-capabilities.md#nodejs).

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

When enabled, Ballin runs a backup at the end of `ballin update`.

If you use backups, review [what they contain](backup-sources.md) and inspect
saved snapshots with `ballin backup list` and `ballin backup read`. Backups can
include inventories from supported package managers available on your Mac,
which you can consult when setting up another Mac.
