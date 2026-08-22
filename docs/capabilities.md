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
| Backups | Runs `ballin backup` as the final update step. | `update.backup=true` and a destination configured with `ballin backup setup`. |

## `ballin doctor`

Maintenance-only Ballin is a supported healthy state. When `backup.id` is
missing, null, blank, or the legacy string `"null"`, doctor reports one optional
Gist backup `INFO` check in verbose mode and executes no `gh` command. The
default healthy output remains `😎 You're ballin.`

When a non-empty ID configures the backup capability, doctor retains the full
host, GitHub CLI, authentication, and Gist-readability checks. Failures in those
checks fail overall health. Missing, malformed, or unreadable core config is not
reinterpreted as maintenance-only.

## `ballin backup`

`ballin backup` backs up changed snapshots to the configured secret GitHub Gist.
Run `ballin backup setup` to create or adopt the optional destination. It can
snapshot:

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

The allowlist identifies which sources Ballin selects; it does not guarantee
that their contents are non-sensitive. See
[Backup sources and sensitivity](backup-sources.md) for the source-by-source
inclusion and risk review. New snapshot categories require that review before
implementation.

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

`ballin backup` collects every available snapshot before changing the Gist. If
collection fails, remote content cannot be read safely, or changes conflict,
Ballin reports the problem and leaves the Gist and backup cache unchanged.

`.backup-cache` is derived local comparison state representing the last remote
base observed by this machine. It is not a destination or enablement flag.
Ballin preserves it while a destination remains configured and invalidates it
before an unconfigured installation creates or adopts a destination. Because
the cache format does not identify a host or Gist ID, setup fails closed rather
than trusting a potentially stale base. After invalidation, differing local and
remote content conflicts instead of authorizing an upload.

Conflicts identify every affected snapshot. Inspect remote content with
`ballin backup read <file>` or the Gist UI, decide which content should win,
reconcile the local environment or remote Gist so the contents match, and rerun
`ballin backup`.

Use one active writer per backup Gist. Ballin does not synchronize or merge
changes from multiple writers.

See [Backup design](backup-design.md) for the underlying safety model and
GitHub constraints.
