# Installation and removal

*User guide to installing, configuring, troubleshooting, and removing Ballin.*

Ballin can be installed for maintenance without configuring backups. Git and a
supported Node.js version are the only prerequisites for the installer. Backups
and integrations such as Homebrew are optional.

## What will installation change?

After you confirm a fresh installation, Ballin clones its checkout into
`~/.ballin-scripts/`, creates local settings there, and links the `ballin`
command into Homebrew's bin directory when available, otherwise `~/.local/bin`.
An existing non-directory command target may be replaced; directories are not
replaced. Declining makes no installation changes and exits successfully.

Analytics, [shell completion](#shell-completion), and
[private backups](#optional-backup-setup-and-reconnect) have separate choices.
Installation does not run updates or collect backup snapshots. See
[local effects](#local-effects) for the affected paths and refresh behavior,
and [uninstall](#uninstall) for removal. Review the [installer source](../install.sh)
before running it.

## Install

Run the installer through Bash process substitution so it can read your
confirmation from standard input:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

A fresh install checks Git and Node.js, prints its plan, and asks for `y/N`
before making installation changes. It then offers
[usage analytics](analytics.md#what-will-analytics-share), disabled by default.
Refreshes preserve existing choices without repeating onboarding.

The core installation completes before Ballin offers optional backup.
Declining backup setup makes no GitHub CLI, authentication, or remote calls. Run
this later to create or reconnect to a destination without reinstalling:

```shell
ballin backup setup
```

If backup setup fails, Ballin remains installed and usable for maintenance.
Follow the reported recovery instructions before running `ballin backup setup`
again. If GitHub may already have created the repository,
inspect the reported repository before retrying. If initialization succeeded,
reconnect to it instead of creating another one.

Self-updates report completion after a successful refresh. They check the
configured backup destination without reading saved snapshot contents.
Warnings and errors remain visible without repeating the setup summary.

Standalone self-update can succeed despite an unreadable saved snapshot.
Run `ballin doctor` to check saved snapshot readability, or `ballin backup setup`
for full validation and the settings summary. During `ballin update`, a full
readiness check follows self-update and reports snapshot-read failures. Fresh
installs show one completion message after setup.

## Shell completion

Ballin includes command completion for zsh and Bash. A fresh interactive
install offers to enable it after the command is installed, showing the startup
file and exact activation line before asking for confirmation (default: no).
Refreshes and `ballin self-update` do not enable completion or ask again.

Completion covers commands, `--help`, `doctor --verbose`, backup snapshot names,
and the `--list` and `--file` options after a snapshot name. `config get` completes
known sections and setting keys; `config set` completes setting keys and boolean
`true`/`false` values.
Unique prefixes work, such as `ballin config set update.cl<Tab>`.
Setting suggestions come from bundled defaults; `set` still requires the key
to exist in your local config.

For `backup read <bundle> --file`, completion offers member paths only from an
existing usable local cache for your selected backup destination. It never
contacts GitHub, fetches a backup, or changes config or cache state. Missing or
unusable cache data produces no suggestions; cached paths may be out of date.
Snapshot-name suggestions describe supported snapshots and do not imply that
they exist in your backup.

### Startup files and manual activation

For the usual zsh setup, choose `home` during installation to use `~/.zshrc`.
To enable completion later, add this line near the end of that file:

```zsh
[[ -r "$HOME/.ballin-scripts/completions/_ballin" ]] && source "$HOME/.ballin-scripts/completions/_ballin"
```

Open a new terminal or run `source ~/.zshrc`. Once this line is present,
`ballin self-update` refreshes the completion scripts; reload the startup file or
open a new terminal to use the updated command list.

If you use `ZDOTDIR`, use the `.zshrc` in that directory instead. During fresh
setup, enter its absolute directory path rather than `home`; for manual setup,
add the line there and reload that file. An exported `ZDOTDIR` is only a hint:
the installer cannot see an unexported value and does not run startup files to
discover it. If you are unsure which directory your terminal uses, press Enter
to skip automatic setup.

For Bash, choose `login` if your terminal reads login startup files, or `bashrc`
if it reads `~/.bashrc`. Login selection uses the first existing file in Bash's
order: `.bash_profile`, `.bash_login`, then `.profile`. To enable completion
manually, add this line to the startup file your session reads and open a new
terminal or reload that file:

```bash
[[ -r "$HOME/.ballin-scripts/completions/ballin.bash" ]] && source "$HOME/.ballin-scripts/completions/ballin.bash"
```

When only `~/.profile` exists, automatic setup skips it because other shells may
read it. Keep that startup chain and add this Bash-only activation line instead:

```sh
[ -n "${BASH_VERSION:-}" ] && [ -r "$HOME/.ballin-scripts/completions/ballin.bash" ] && . "$HOME/.ballin-scripts/completions/ballin.bash"
```

### If automatic activation is skipped or fails

Automatic setup appends one guarded line, preserving existing contents and
permissions; a missing standard file is created privately. Symlinked startup
files, uncertain or unsupported shell settings, noninteractive installs,
unfinished line continuations, and write failures use the manual path. Completion
setup does not make core installation fail. If an append fails, Ballin attempts
to restore the original bytes; if restoration fails or conflicting changes are
detected, inspect the file Ballin identifies before reloading it. If Ballin
reports an existing activation with a trailing carriage return, replace only
that line manually with the displayed command using LF line endings.

## Local effects

### Quickstart helper

The [quickstart helper](quickstart.md) reuses Git, compatible Node.js, and GitHub
CLI. It requires macOS 13.5 or newer and zsh or Bash. Homebrew is optional.

[View the setup script](../quickstart.sh).

For missing prerequisites, it asks before starting Apple's Command Line Tools
installation for Git, installing the latest official Node.js 24 macOS package,
or downloading GitHub CLI for your shell's architecture. Node's installer may
replace Node.js/npm in `/usr/local` and request your Mac administrator password.
Downloads are checked against published SHA-256 checksums; the Node package's
Apple signature and publisher are checked before requesting admin access.

Helper files and managed tool links live in `~/.local/share/ballin-quickstart/`.
A compatible Node already first on PATH stays under its existing version manager;
otherwise, the helper selects a fallback. It displays the exact PATH line and
asks before appending it to your startup file.

Select the file your terminal reads: `home` or an absolute directory containing
`.zshrc` for zsh; `login` or `bashrc` for Bash. Press Enter to skip if unsure.
Shell completion is a separate optional installer step.

Open a new Terminal afterward, or run the displayed PATH line in your current
window. **Already present** does not guarantee that a line executes. If `ballin`
is unavailable, check your startup file and place the line where it executes.
Skipped, declined, or unsafe edits leave the file untouched and report
**persistent PATH setup incomplete**. Setup can continue using the helper's
PATH; edit the file manually or rerun the quickstart to retry.

GitHub CLI must authenticate before the core installer runs. The helper reuses
existing authentication or offers normal browser login. If an exported token
blocks login, follow GitHub CLI's instructions; the helper does not change
exported credentials or switch accounts.

After installation, it asks whether to run the first backup and open its GitHub
destination: Enter or `y` accepts both; `n` skips both; end-of-input cancels.
Normal backup setup prompts still apply. Declining setup leaves Ballin installed
without capturing or opening a backup. The destination opens only after
successful capture.

Cancellation can leave completed prerequisite steps for retry. Reruns reuse tools
and revalidate existing backups. `ballin uninstall` leaves prerequisites, helper
files, and the confirmed PATH line in place.

### Core installer

The installer can create or change:

- `~/.ballin-scripts/`, a local Git checkout of `ballin-scripts`. Rerunning the
  installer updates this checkout; if local changes block checkout or merge,
  Ballin may move tracked and untracked changes to a Git stash during recovery.
- `~/.ballin-scripts/ballin.config.json`, which stores local Ballin settings.
  Reconnecting to a backup can recover supported portable preferences while
  preserving existing local choices.
- `~/.ballin-scripts/.analytics/install-id` when analytics are enabled. See
  [Analytics](analytics.md) for the related controls and privacy details.
- `<bin>/ballin`, a symbolic link to `~/.ballin-scripts/bin/ballin`. `<bin>` is
  `$(brew --prefix)/bin` when `brew` is available, otherwise
  `~/.local/bin`. The selected directory must already be on `PATH`.
- Your selected shell startup file, only when you confirm optional completion
  activation.
- `~/.ballin-scripts/.backup-cache` during confirmed-state cache promotion. It is
  home to comparison state and the local last-success record, not the backup
  destination or an enablement flag.

Before creating the command link, setup removes an existing non-directory
target at `<bin>/ballin`. It refuses to replace a directory.

Private transport and staged config files are removed after setup. The
installer does not run `ballin update`, collect snapshots, perform the first
backup, install optional tools, or change GitHub CLI authentication.

## Commands and services contacted

The command shown above downloads `install.sh` from GitHub. The installer then:

- runs local Git and Node.js prerequisite checks;
- obtains the Ballin checkout from GitHub;
- runs `brew --prefix` only when Homebrew is present, to select a command-link
  directory;
- makes no GitHub CLI calls when optional backup setup is declined;
- during repository backup setup, checks the personal GitHub.com account
  currently used by `gh` and the selected destination, then after confirmation
  either reconnects to an existing backup or creates a private backup repository;
- sends no analytics request during installation. Later Ballin commands may send
  analytics as described in [Analytics](analytics.md).

The first `ballin backup` is a separate command. It collects the current
selected allowlisted sources, reads the destination, and saves changes that pass
the conflict checks. See [Backup sources and sensitivity](backup-sources.md).

## Revisiting onboarding choices

After installation, run `ballin setup` to review your local sensitive-source,
automatic-backup, and analytics choices using their current values as defaults.
It does not reinstall Ballin, change backup destinations, or run backup/update.
See [guided preference review](optional-capabilities.md#guided-preference-review)
for applicable choices and cancellation behavior. Use `ballin backup setup`
when you need to create or reconnect a destination.

## Optional backup setup and reconnect

```shell
ballin backup setup
ballin backup setup my-backup-name
```

Backups are stored in a private GitHub repository. GitHub and anyone authorized
to access the repository can read its contents.

New setup offers distinct **create** and **reconnect** choices and defaults to
`ballin-backups`. The optional argument is a repository name, not a URL or owner.
Backups belong to the authenticated personal GitHub.com account. Setup shows
that account and the complete destination before final confirmation. A missing
or inaccessible reconnect candidate never causes replacement creation; a create
collision requires an explicit different name or reconnect choice.
New repositories start with Issues, Wiki, Projects, and pull requests disabled.
Disabling pull requests requires Administration (write) on the effective GitHub
credential; creation permission alone may be insufficient. If that step fails,
setup reports the created repository for inspection without saving local linkage.
Reconnect leaves existing feature settings unchanged.

Fresh create or reconnect setup asks whether to include sensitive sources,
with No as the default. Review
[what Ballin will back up](backup-sources.md#what-will-ballin-back-up) for the
baseline, sensitive-source scope, and privacy limitations.

Reconnect inspects the existing backup before asking. Declining skips
sensitive-source discovery. Selecting it reviews paths, resolved targets, and
availability. For synced Claude skills, Ballin reads local collection manifests
to select plugin packages; it does not read selected file contents or create
backup snapshots during this preview. Access or resolution errors stop setup.
See [source preview](backup-sources.md#repository-inclusion).

Final confirmation covers the destination and source selection. If you decline,
Ballin makes no backup-specific changes. If you approve, it revalidates the
destination, creates or reconnects to the repository, attempts optional branch
protection, clears local backup comparison state, and then saves the destination,
sensitive-source choice, and any supported preferences recovered from the backup.
Successful new protection gets one concise confirmation. Unsupported protection
is silent. A permission note or warning about unconfirmed protection is nonfatal
and does not mean backup
setup failed. After updating GitHub access, rerun `ballin backup setup` to make a
bounded protection attempt on the configured repository without changing local
backup choices.

Reconnect restores only
[supported Ballin preferences](optional-capabilities.md#recovering-ballin-preferences), and
existing local choices take precedence. It does not restore saved dotfiles or
reinstall saved packages.

After creating or reconnecting a backup, Ballin asks whether `ballin update`
should run backups automatically (default: no). The choice is stored in
`update.backup`; change it later with `ballin config set update.backup true` or
`false`. If Ballin cannot save the choice, the backup destination remains
configured, and Ballin reports the partial result.

### GitHub authentication and protection

Ballin uses your existing `gh` authentication. It does not log in, switch
accounts, or expand permissions on your behalf. Normal browser-based
[`gh` authentication](https://cli.github.com/manual/gh_auth_login) works when
the active personal account owns the destination. Routine backup publication
requires contents write access. Optional policy hardening can require additional
repository authority, but read, open, recovery, and normal publication do not.

If you use a fine-grained token, choose the same personal account as its resource
owner and ensure it can access the selected repository and write backup contents.
A token limited to selected existing repositories may reconnect when it can
access the destination, but it cannot be assumed to access a repository that
Ballin creates later. If authentication is missing, run
`gh auth login --hostname github.com`. If Ballin shows an unexpected account,
check whether an environment token is overriding your saved `gh` login.

GitHub Free is supported. When the repository and current GitHub permissions
support it, setup automatically adds optional branch protection against force
pushes and branch deletion. Backup setup and normal use remain supported when
that extra protection is unavailable. See [Supported capabilities](capabilities.md#github-side-history-protection)
for the exact safety boundary and current GitHub eligibility.

### Already-configured backups and destination changes

For an already-configured backup, `ballin backup setup` shows the validated
destination, whether sensitive sources are included, and whether automatic
backup during update is enabled, plus the
[local last-success record](backup-sources.md#last-successful-backup). It then
offers to review sensitive-source inclusion and automatic backup using your
current settings as defaults. The sensitive-source choice requires explicit
confirmation; both choices are saved after the review completes. Cancelling
leaves these settings unchanged. This review keeps the destination and does not
run a backup.

To change sensitive-source inclusion or automatic backup during update while
keeping your destination, run `ballin setup` for
[guided preference review](optional-capabilities.md#guided-preference-review)
or use the
[backup settings commands](optional-capabilities.md#private-repository-backups).

Renaming the repository on GitHub does not break the connection: Ballin continues
to recognize the same backup. To switch to a different repository, disconnect
first:

```shell
ballin backup disconnect
ballin backup setup new-repository-name
```

Disconnect clears local backup linkage and `.backup-cache`, and disables
automatic backup during updates. Remote history and shared `gh` authentication
remain unchanged. Setup offers create or reconnect and asks for sensitive-source
and automatic-backup choices again. See [Disconnect](#disconnect) for preserved
preferences and failure handling.

Ballin backup repositories must be private, belong to the personal GitHub.com
account used for setup, and meet Ballin's other support requirements.

If a name redirects to a renamed repository, **create** can reclaim it after
setup warns you and you confirm. This ends the old redirect, so links and clones
using that URL no longer reach the renamed repository. Its contents and
visibility are unchanged. To reconnect, use the repository's current name.

## Disconnect

```shell
ballin backup disconnect
```

Disconnect atomically clears local backup associations and
sets `update.backup="false"`, then removes `.backup-cache`. It preserves sensitive
consent and unrelated preferences. It requires no authentication
or network operation and leaves remote history and shared `gh` authentication
unchanged. A failed config save retains the prior selection. If cleanup fails
after saving, writes stay disabled; repeat disconnect to retry cleanup even when
already unconfigured.

## Health and recovery

`ballin doctor` treats maintenance-only Ballin as healthy and invokes no `gh`.
Configured repositories are checked for authentication, expected private identity,
supported layout, and coherent readability. This is readiness only: it does not
collect, repair cache permissions, probe writes, or establish backup freshness,
coverage, or successful publication.

Use `ballin backup list` to find supported snapshots saved in the configured
backup, then `ballin backup read <snapshot>` to print one. Use `ballin backup open`
to inspect the backup in your browser, including retired snapshots and unexpected
entries. These commands require remote access and work with read-only
permissions. For offline help, run `ballin backup --help`.

Bundle snapshots use `.bundle.json` filenames. List their files, then read one
using its original stored path:

```shell
ballin backup read codex_skills.bundle.json --list
ballin backup read codex_skills.bundle.json --file 'example/SKILL.md'
```

`--list` displays control and directional characters as visible escapes;
`--file` does not decode those escapes. For escaped or ambiguous names, read the
raw bundle without `--list` or `--file` and pass the selected entry’s JSON-decoded
`path` value to `--file` as one shell argument. See
[bundle inspection](backup-design.md#bundle-inspection) for details.

`--file` prints the original bytes, including binary content and line endings.
These commands inspect saved content without restoring files or executing them.

For local history inspection, clone your backup repository with Git:

```shell
git clone https://github.com/example-user/ballin-backups.git
```

Use only one Mac to back up to a destination.
Stop using the previous Mac for backups before publishing from a replacement Mac.
After reconnect, Ballin has no saved comparison baseline. If newly captured
content or metadata differs from the saved backup, Ballin reports a conflict
instead of overwriting it. Inspect and manually reconcile conflicts using the
[conflict guidance](capabilities.md#backup-consistency-and-conflicts).

If installation fails before setup completes, fix the reported problem and
retry installation. If only optional backup setup fails, retry with
`ballin backup setup`.

## Uninstall

Run:

```shell
ballin uninstall
```

Uninstall removes Ballin-owned command symlinks and recursively deletes
`~/.ballin-scripts`, including config, analytics install ID, and backup cache. It
does not delete a remote backup, its revision history, or GitHub CLI credentials.
Completion activation lines remain in shell startup files. Their readability
guard skips the removed asset; you can remove the displayed activation line
manually if desired.

When analytics remain enabled, uninstall can send its normal final top-level
command event using state captured before local deletion.

## Manual removal

If the command cannot run, inspect the potential link locations first:
`~/.local/bin/ballin`, `/opt/homebrew/bin/ballin`, `/usr/local/bin/ballin`, and
`$(brew --prefix)/bin/ballin` for a custom Homebrew prefix. Remove only links
whose target is `~/.ballin-scripts/bin/ballin`, then remove
`~/.ballin-scripts`. Remote backups and GitHub CLI authentication require separate
manual action if you also want to remove them.
