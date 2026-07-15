# Supported capabilities

This reference lists the update and backup surfaces that `ballin-scripts`
currently manages. Optional tools run according to the discovery and setting
rules below; configured integrations that are enabled but unavailable are
reported as failures.

## `ballin update`

`ballin update` updates the local development environment through these
integrations. If an integration command fails, it still runs any later
integrations and exits nonzero at the end. When more than one stage fails, the
last nonzero stage status is returned.

Update settings are loaded and validated once before any integrations run.
Missing settings in an older or partial `update` section use bundled defaults
in memory for that run and produce one warning; `ballin update` does not rewrite
the config. Invalid config structures or setting values fail before any
integration runs.

| Area | Behavior | Requirement |
| --- | --- | --- |
| Homebrew packages | Runs `brew upgrade`, optional `brew cleanup`, and `brew doctor`. | `brew` on `PATH`; `update.cleanup` controls cleanup. |
| Node.js LTS | Runs `nvm install --lts`; a missing nvm installation or failure to capture its updated environment records a failure while later stages continue. | `update.nvm=true`, `NVM_DIR` set, and `nvm.sh` present. |
| Global npm packages | Runs `npm update -g`; a missing `npm` command records a failure while later stages continue. | `update.npm=true` and `npm` on `PATH`. |
| Mac App Store apps | Runs `mas upgrade`. | `mas` on `PATH`. |
| macOS updates | Runs `softwareupdate -ia`; a missing command records a failure while later stages continue. | `update.softwareupdate=true` and `softwareupdate` on `PATH`. |
| ballin-scripts | Runs Ballin self-update, then records a failed readiness result while continuing to a configured backup. | `update.selfUpdate=true`. |
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

### Current consistency boundary

Use one active writer per backup Gist. Multiple machines can point at the same
Gist, but Ballin does not currently synchronize or merge their snapshots, so a
machine can overwrite another machine's changes.

A backup currently uploads changed files with separate Gist edits. A failure
between edits can leave one logical backup spread across multiple revisions or
only partly uploaded. Staged collection, conflict detection, a single-request
upload, and cache updates after remote success are tracked in
[#282](https://github.com/JBallin/ballin-scripts/issues/282).
