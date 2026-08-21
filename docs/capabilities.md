# Supported capabilities

This reference lists Ballin's update and backup capabilities. Auto-discovered
integrations run when available; configured integrations fail when enabled but
unavailable.

## `ballin update`

`ballin update` runs these integrations in order. A failure does not stop later
integrations. The command exits nonzero after all configured stages finish,
using the last nonzero stage status when several stages fail.

Before starting, Ballin loads and validates the update settings once. Missing
known settings use bundled defaults in memory and produce one warning; the
config file remains unchanged. Malformed JSON, invalid config structure, or
invalid known setting values fail before any integration runs.

| Area | Behavior | Requirement |
| --- | --- | --- |
| Homebrew packages | Runs `brew upgrade`, optional `brew cleanup`, and `brew doctor`. | `brew` on `PATH`; `update.cleanup` controls cleanup. |
| Node.js LTS | Runs `nvm install --lts`; a missing nvm installation or failure to capture its updated environment records a failure while later stages continue. | `update.nvm=true`, `NVM_DIR` set, and `nvm.sh` present. |
| Global npm packages | Runs `npm update -g`; a missing `npm` command records a failure while later stages continue. | `update.npm=true` and `npm` on `PATH`. |
| Mac App Store apps | Runs `mas upgrade`. | `mas` on `PATH`. |
| macOS updates | Runs `softwareupdate -ia`; a missing command records a failure while later stages continue. | `update.softwareupdate=true` and `softwareupdate` on `PATH`. |
| ballin-scripts | Runs Ballin self-update, then checks readiness. A failed check records a failure while a configured backup still runs. | `update.selfUpdate=true`. |
| Backups | Runs `ballin backup` as the final update step. | `update.backup=true`. |

## `ballin backup`

`ballin backup` backs up changed snapshots to the configured secret GitHub Gist.
It can snapshot:

| Area | Snapshot files | Requirement |
| --- | --- | --- |
| Shell startup files | `bash_profile.sh`, `bashrc.sh`, `profile.sh`, `zprofile.sh`, `zshrc.sh` | Matching dotfiles in `HOME`. |
| Bash completions | `bash_completions` | Homebrew completion directory or `BALLIN_BACKUP_BASH_COMPLETION_DIR`. |
| Homebrew inventory | `brew_list`, `brew_leaves`, `brew_cask`, `brew_services`, `Brewfile` | `brew` on `PATH`. |
| Git config | `gitconfig`, `gitignore_global` | Matching dotfiles in `HOME`. |
| Global npm packages | `npm_global` | `npm` on `PATH`. |
| Python tooling | `pipx`, `uv_tools`, `pyenv_versions` | `pipx`, `uv`, or `pyenv` on `PATH`. |
| Node version preference | `nvmrc` | `.nvmrc` in `HOME`. |
| VS Code | `vs_settings`, `vs_keybindings`, `vs_extensions` | VS Code user files; `code` for extension list. |
| VS Code Insiders | `vsI_settings`, `vsI_keybindings`, `vsI_extensions` | VS Code Insiders user files; `code-insiders` for extension list. |
| Brackets | `brackets_settings.json`, `brackets_keymap.json`, `brackets_extensions`, `brackets_disabled_extensions` | Brackets support files in `HOME`. |
| Editor config files | `vimrc`, `nanorc` | Matching dotfiles in `HOME`. |
| Ballin config | `ballin_config` | Local `ballin.config.json` file. |
| Mac App Store apps | `mas` | `mas` on `PATH`. |

For Homebrew, Ballin generates the saved `Brewfile` from the current Mac through
Homebrew Bundle by running `brew bundle dump --file=-`. It stores the Brewfile
alongside separate inventories for formulae, leaves, casks, and services. This
capability is capture/reference only: `ballin backup` does not use the Brewfile
to check, install, clean up, or upgrade packages, or to run another apply/restore
workflow.

### Output markers

`ballin backup` prints one line per meaningful snapshot result:

| Marker | Meaning |
| --- | --- |
| `✚` | Newly saved or newly meaningful snapshot. |
| `✎` | Existing snapshot content changed. |
| `✖︎` | Existing snapshot became empty. |
| `✔` | Unchanged non-empty snapshot. |

Unchanged empty snapshots do not print a line.

Markers are delayed until the complete logical run has succeeded, including
any required Gist update and local cache promotion. A failed run does not
print partial success markers.

### Backup consistency and conflicts

`ballin backup` is a staged single-request backup. It captures and normalizes
every available snapshot before reading current remote content. If any
collector fails, Ballin still attempts the later collectors and reports their
failures, but changes neither the Gist nor the backup cache.

Ballin checks cached, remote, and local content before uploading safely changed
files in at most one request. If it detects conflicting changes or cannot read
remote state safely, it stops without changing the Gist or cache.

Conflicts identify every affected snapshot. Inspect remote content with
`ballin backup read <file>` or the Gist UI, decide which content should win,
reconcile the local environment or remote Gist so the contents match, and rerun
`ballin backup` to establish the cache.

Cache files and result markers are updated only after the remote outcome is
known. A failed or interrupted request leaves caches unchanged so rerunning the
command rechecks current remote state.

Use one active writer per backup Gist. Ballin does not synchronize, merge, or
eliminate the race in which another writer changes the Gist between Ballin's
read and write.

See [Backup design](backup-design.md) for the underlying safety model and
GitHub constraints.
