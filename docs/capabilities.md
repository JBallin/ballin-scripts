# Supported capabilities

This reference lists the update and backup surfaces that `ballin-scripts`
currently manages. Optional tools are used only when the matching command or
setting is available.

## `ballin update`

`ballin update` updates the local development environment through these
integrations. If an integration command fails, it still runs any later
integrations and exits nonzero at the end.

| Area | Behavior | Requirement |
| --- | --- | --- |
| Homebrew packages | Runs `brew upgrade`, optional `brew cleanup`, and `brew doctor`. | `brew` on `PATH`; `update.cleanup` controls cleanup. |
| Node.js LTS | Runs `nvm install --lts`. | `update.nvm=true`, `NVM_DIR` set, and `nvm.sh` present. |
| Global npm packages | Runs `npm update -g`. | `update.npm=true` and `npm` on `PATH`. |
| Mac App Store apps | Runs `mas upgrade`. | `mas` on `PATH`. |
| macOS updates | Runs `softwareupdate -ia`. | `update.softwareupdate=true` and `softwareupdate` on `PATH`. |
| ballin-scripts | Runs Ballin self-update. | `update.selfUpdate=true`. |
| Backups | Runs `ballin backup` as the final update step. | `update.backup=true`. |

## `ballin backup`

`ballin backup` backs up changed snapshots to the configured private Gist. It
can snapshot:

| Area | Snapshot files | Requirement |
| --- | --- | --- |
| Shell startup files | `bash_profile.sh`, `bashrc.sh`, `profile.sh`, `zprofile.sh`, `zshrc.sh` | Matching dotfiles in `HOME`. |
| Bash completions | `bash_completions` | Homebrew completion directory or `BALLIN_BACKUP_BASH_COMPLETION_DIR`. |
| Homebrew inventory | `brew_list`, `brew_leaves`, `brew_cask`, `brew_services`, `Brewfile` | `brew` on `PATH`. |
| Git config | `gitconfig`, `gitignore_global` | Matching dotfiles in `HOME`. |
| Global npm packages | `npm_global` | `npm` on `PATH`. |
| Node version preference | `nvmrc` | `.nvmrc` in `HOME`. |
| VS Code | `vs_settings`, `vs_keybindings`, `vs_extensions` | VS Code user files; `code` for extension list. |
| VS Code Insiders | `vsI_settings`, `vsI_keybindings`, `vsI_extensions` | VS Code Insiders user files; `code-insiders` for extension list. |
| Brackets | `brackets_settings.json`, `brackets_keymap.json`, `brackets_extensions`, `brackets_disabled_extensions` | Brackets support files in `HOME`. |
| Editor config files | `vimrc`, `nanorc` | Matching dotfiles in `HOME`. |
| Ballin config | `ballin_config` | Local `ballin.config.json` file. |
| Mac App Store apps | `mas` | `mas` on `PATH`. |
