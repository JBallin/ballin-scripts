# Installation and removal

**Audience:** Users

Ballin can be installed for maintenance without configuring backups. Git and a
supported Node.js version are the only prerequisites for the installer. Backups
and integrations such as Homebrew are optional.

## Install

Review the [installer source](../install.sh), then run it through Bash process
substitution so the installer can read your confirmation from standard input:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

A fresh install checks Git and Node.js, prints its plan, and asks for `y/N`
before cloning or making installation changes. Declining exits successfully
without cloning. During setup, Ballin creates the local installation and asks
whether to enable [usage analytics](analytics.md), with No as the default.
This one local choice covers command usage and outcomes, real backup outcomes,
and automatic backup and self-update outcomes during `ballin update`. It is
not saved in backups or restored when reconnecting; ordinary refreshes and
self-updates preserve the choice without asking again. Installation and the
choice send no analytics event.

The core installation completes before Ballin offers optional backup.
Declining backup setup makes no GitHub CLI, authentication, or remote calls. Run
this later to create or reconnect to a destination without reinstalling:

```shell
ballin backup setup
```

If backup setup fails, Ballin remains installed and usable for maintenance. Retry
with `ballin backup setup`. If GitHub may already have created the repository,
inspect the reported repository before retrying. If initialization succeeded,
reconnect to it instead of creating another one.

Self-updates report “Ballin updated.” after a successful refresh. During
`ballin update`, a readiness check follows. Fresh installs keep one completion
message after setup.

## Shell completion

Ballin includes command completion for zsh and Bash. A fresh interactive
install offers to enable it after the command is installed, showing the startup
file and exact activation line before asking for confirmation (default: no).
Refreshes and `ballin self-update` do not enable completion or ask again.

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

Automatic setup appends one guarded line, preserving existing contents and
permissions; a missing standard file is created privately. Symlinked startup
files, uncertain or unsupported shell settings, noninteractive installs,
unfinished line continuations, and write failures use the manual path. Completion
setup does not make core installation fail. If an append fails, Ballin attempts
to restore the original bytes; if restoration fails or conflicting changes are
detected, inspect the file Ballin identifies before reloading it. If Ballin
reports an existing activation with a trailing carriage return, replace only
that line manually with the displayed command using LF line endings.

Completion covers supported top-level commands and the operations under
`ballin backup` and `ballin config`. Unique prefixes work too, such as
`ballin upd<Tab>`, `ballin backup op<Tab>`, and `ballin config ge<Tab>`.
Completion does not cover options, values, or file paths.

## Local effects

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
  derived comparison state, not the backup destination or an enablement flag.

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

GitHub Free is supported. When the repository and current GitHub permissions
support it, setup automatically adds optional branch protection against force
pushes and branch deletion. Backup setup and normal use remain supported when
that extra protection is unavailable. See [Supported capabilities](capabilities.md#github-side-history-protection)
for the exact safety boundary and current GitHub eligibility.

New setup offers distinct **create** and **reconnect** choices and defaults to
`ballin-backups`. The optional argument is a repository name, not a URL or owner.
Backups belong to the authenticated personal GitHub.com account. Setup shows
that account and the complete destination before final confirmation. A missing
or inaccessible reconnect candidate never causes replacement creation; a create
collision requires an explicit different name or reconnect choice.

If a name redirects to a renamed repository, **create** can reclaim it after
setup warns you and you confirm. This ends the old redirect, so links and clones
using that URL no longer reach the renamed repository. Its contents and
visibility are unchanged. To reconnect, use the repository's current name.

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

Fresh create or reconnect setup asks whether to include **sensitive sources**:
raw shell/Git/editor configuration, `.nvmrc`, and pipx installation metadata.
This single choice is saved as `backup.includeSensitive` and defaults off.
Reconnect fully inspects the existing backup before asking. Declining performs
no sensitive-source discovery. Selecting it reviews logical paths, resolved
regular-file targets (including symlinks outside `HOME`), and missing or
unavailable sources. pipx is described separately. Review
reads no raw contents and runs no collectors; access or resolution errors stop
setup. See
[Source review](backup-sources.md#repository-inclusion).

Final confirmation covers the destination and source selection. If you decline,
Ballin makes no backup-specific changes. If you approve, it revalidates the
destination, creates or reconnects to the repository, attempts optional branch
protection, and then saves the destination, sensitive-source choice, and any
supported preferences recovered from the backup. Successful new protection gets
one concise confirmation. Unsupported protection is silent. A permission note
or warning about unconfirmed protection is nonfatal and does not mean backup
setup failed. After updating GitHub access, rerun `ballin backup setup` to make a
bounded protection attempt on the configured repository without changing local
backup choices.

For an already-configured backup, setup shows the validated destination,
whether sensitive sources are included, and whether automatic backup during
update is enabled. It preserves these choices and shows the
[local last-success record](backup-sources.md#last-successful-backup) separately.
This summary does not compare current sources with saved snapshots.

After saving the sensitive-source choice, setup confirms the config key and
value using the same format as `ballin config set`, for example:

```text
"backup.includeSensitive" set to: "false"
```

This confirmation appears before the automatic-backup question. See
[backup settings](optional-capabilities.md#private-repository-backups) to change
the choice later.

Renaming the repository on GitHub does not break the connection: Ballin continues
to recognize the same backup. To switch to a different repository, disconnect
first and run `ballin backup setup` again. Ballin backup repositories must be
private, belong to the personal GitHub.com account used for setup, and meet
Ballin's other support requirements.

Reconnect restores only
[supported portable preferences](backup-design.md#portable-preferences), and
existing local choices take precedence. It does not restore saved dotfiles or
reinstall saved packages.

After creating or reconnecting a backup, Ballin asks whether `ballin update`
should run backups automatically (default: no). The choice is stored in
`update.backup`; change it later with `ballin config set update.backup true` or
`false`. If Ballin cannot save the choice, the backup destination remains
configured, and Ballin reports the partial result.

## Disconnect

```shell
ballin backup disconnect
```

Disconnect atomically clears local backup associations and
sets `update.backup="false"`, then removes `.backup-cache`. It preserves sensitive
consent and unrelated preferences. It requires no authentication
or network operation and leaves remote history intact. A failed config save
retains the prior selection. If cleanup fails after saving, writes stay disabled;
repeat disconnect to retry cleanup even when already unconfigured.

## Health and recovery

`ballin doctor` treats maintenance-only Ballin as healthy and invokes no `gh`.
Configured repositories are checked for authentication, expected private identity,
supported layout, and coherent readability. This is readiness only: it does not
collect, repair cache permissions, probe writes, or establish backup freshness,
coverage, or successful publication.

`ballin backup read <file>` prints exact supported snapshot bytes;
`ballin backup open` opens the validated destination. Both work with read-only
access and leave caches unchanged. Use only one Mac to back up to a destination.
Stop using the previous Mac for backups before publishing from a replacement Mac.
A reconnect has no trusted base and cannot overwrite differing remote content;
inspect and manually reconcile each conflict using the
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
