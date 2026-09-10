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

Maintenance-only Ballin is healthy: verbose doctor output shows one optional
backup `INFO` check and executes no `gh`. Configured repositories require the
effective personal GitHub.com account, expected private destination identity,
supported layout, and coherent readability. Invalid configuration or failed
checks affect overall health. Doctor does not collect snapshots, probe writes,
repair cache permissions, or claim freshness, coverage, or verified publication.
Configured legacy Gists retain host, authentication, and readability checks.

## `ballin backup`

`ballin backup` saves changed snapshots to the configured destination. New setup
uses private GitHub.com repositories; run `ballin backup setup [repository-name]`
to create or reconnect. Existing configured Gists remain supported until migration
and retirement in [#334](https://github.com/JBallin/ballin-scripts/issues/334).

Repository backups include a fixed baseline of inventories and filtered
preferences; raw configuration and pipx require the single local sensitive-source
choice. Existing Gist backups still select all available sources. Sources are:

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
| Editor config files | `vimrc`, `nanorc` | Matching dotfiles in `HOME`. |
| Ballin preferences | `ballin_config` | Local `ballin.config.json`; only supported preferences are saved. See [preference recovery](optional-capabilities.md#recovering-ballin-preferences). |
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
any required publication confirmation and local cache promotion. A failed run
does not print partial success markers.

### Backup consistency and conflicts

`ballin backup` stages every selected available snapshot before remote inspection.
Collector failure aborts the run. Excluded, absent, unavailable, and failed-discovery
sources are skipped and retain any saved content. For repositories, complete
revision-bound reads are required before interpreting a missing remote file or
comparing bytes.

The owner-only `.backup-cache` represents the last confirmed remote base observed
by this machine. Repository entries are scoped to stable owner/repository IDs and
the selected branch; names and legacy cache files cannot authorize publication.
New linkage invalidates untrusted caches. Existing cache directories and files
are secured before backup; symlinks are rejected. Permission repairs may remain
when a run fails, while source permissions stay unchanged.

Ballin compares local, cached, and remote bytes and presence. A differing remote
file without a base, a remotely deleted file with a base, or a remote change
that matches neither base nor local capture is a conflict. Every conflict is
reported before any publication or content promotion. Matching local and remote
bytes can hydrate or advance the cache without a commit.

For repository backups, safe changes publish through one conditional commit
based on the inspected head. A true no-op makes no remote mutation. Rejected,
stale, or unconfirmed publication leaves caches unchanged. After confirmation,
cache failures report the completed remote effect without normal success markers.
A fresh invocation re-reads and reconciles; matching remote/local bytes recover
without another publication.

Inspect each conflict with `ballin backup read <file>` or the GitHub UI. Decide
which content to retain and deliberately reconcile local and remote bytes so
they match before rerunning. Do not delete the cache to authorize overwrites.
Ballin offers no force, merge, blind retry, or automatic replacement destination.
Use one active writer, retiring the prior writer before a replacement Mac
publishes. Reconnect supports recovery but grants no authority to overwrite
saved data. Read/open do not execute content or change caches.

Existing configured Gists retain the same three-way comparison, but their API
has no conditional-head guarantee. See [Backup design](backup-design.md) for
storage details and constraints; migration and verification remain separate.
