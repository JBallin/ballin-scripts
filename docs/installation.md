# Installation and removal

*User guide to installing, configuring, troubleshooting, and removing Ballin.*

Ballin can be installed for maintenance without configuring backups. Git and a
supported Node.js version are the only prerequisites for the installer. Backups
and integrations such as Homebrew are optional. Ballin has no runtime npm
dependencies.

Ballin's installer and terminal output take inspiration from
[Homebrew](https://brew.sh/).

## What will installation change?

After you confirm a fresh installation, Ballin clones its checkout into
`~/.ballin-scripts/`, creates local settings there, and links the `ballin`
command into Homebrew's bin directory when available, otherwise `~/.local/bin`.
An existing non-directory command target may be replaced; directories are not
replaced. Declining makes no installation changes.

Analytics, [shell completion](#shell-completion), and
[private backups](#optional-backup-setup-and-reconnect) have separate choices.
The direct installer does not run updates or capture a backup. Quickstart may
offer to run the first backup after successful destination setup. See
[what installation changes](#what-installation-changes) for the affected paths
and refresh behavior, and [uninstall](#uninstall) for removal. Review the
[installer source](../install.sh) before running it.

## Install

Choose a route:

- [Direct installer](../README.md#installation) if Git and a supported Node.js are already available.
- [Guided Quickstart](quickstart.md#quickstart-install-ballin) to check prerequisites and offer missing tools.

Both guides provide the command to paste into Terminal. Zsh and Bash are supported.

A fresh install checks Git and Node.js, previews installation details, and asks for `[y/N]`
before making installation changes. It then offers
[usage analytics](analytics.md#what-will-analytics-share), disabled by default.
Refreshes preserve existing choices without repeating onboarding.

Successful setup ends with a reminder to open a new Terminal and run `ballin help`.
If Quickstart cannot verify PATH setup for finding `ballin` in a new Terminal,
it provides manual PATH setup instructions.

The core installation completes before Ballin offers optional backup.
Declining backup setup makes no GitHub CLI, authentication, or remote calls. Run
this later to create or reconnect to a destination without reinstalling:

```shell
ballin backup setup
```

If backup setup fails, Ballin remains installed and usable for maintenance.
Follow the reported recovery instructions before running `ballin backup setup`
again. If GitHub may already have created the repository,
inspect the reported repository before retrying. If initialization succeeded but
local linkage was not saved, reconnect to it instead of creating another one.
If Ballin reports that the destination is saved locally, keep that linkage and
run `ballin setup` to review the remaining preferences.

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
file before asking for confirmation (default: no). The exact activation lines
and undo instructions are below.
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

For Zsh, setup suggests `~/.zshrc`, or an absolute exported `ZDOTDIR` when
available. Press Enter to use the suggestion, enter another absolute directory,
or choose `skip` for manual setup. The suggestion does not prove which file your
Terminal reads. Setup shows the selected file and asks before changing it.
PATH and completion require separate permissions.
To enable completion later, add this line near the end of that file:

```zsh
[[ -r "$HOME/.ballin-scripts/completions/_ballin" ]] && source "$HOME/.ballin-scripts/completions/_ballin"
```

Open a new Terminal, or reload the startup file you selected. Once this line is present,
`ballin self-update` refreshes the completion scripts; reload the startup file or
open a new terminal to use the updated command list.

If you use a custom `ZDOTDIR`, select the directory containing the `.zshrc` your
Terminal reads, even if it differs from the suggestion. Setup never runs startup
files to discover a location. A missing `.zshrc` is normal.
Quickstart can reuse the file you selected for PATH when offering completion,
with separate permission to enable it. Choosing a file alone makes no changes.

An existing exact activation is not appended again. To disable completion,
remove only Ballin's guarded activation line; reload the file or open a new
Terminal. Self-update refreshes the completion
assets and does not re-enable a removed line.

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
that line with the activation for your shell in
[manual activation](#startup-files-and-manual-activation), using LF line endings.

## What installation changes

### Quickstart helper

The [quickstart helper](quickstart.md) ([setup script](../quickstart.sh)) reuses
Git, compatible Node.js, and GitHub CLI. It requires macOS 13.5 or newer and zsh
or Bash. Homebrew is optional.

Quickstart first asks whether to set up backups. No still installs Ballin for
maintenance; it omits backup-only GitHub CLI discovery/installation, sign-in,
destination setup and run-now. Existing tools, accounts and backups remain.
Later `ballin backup setup` checks current prerequisites and GitHub access.

Compatible existing Git, Node.js and (when selected) GitHub CLI are reused.
Node must meet the [package requirement](../package.json), currently >=24.12;
a newer compatible major is accepted. An incompatible or unverifiable existing
Node requires manual attention. For a compatible installed Node outside PATH,
activate it or add its bin directory to PATH instead of installing another copy.
Follow the reported guidance and your existing installation method, or the
[Node guidance](optional-capabilities.md#nodejs), then rerun Quickstart.
Quickstart never automatically upgrades or switches an existing incompatible
Node, installs nvm, or bootstraps Homebrew.

For genuinely missing tools, a suitable native existing Homebrew installation
is preferred for Git, Node and GitHub CLI. The Node route uses ordinary
`brew install node`: Homebrew's **default formula**, which may move to a newer
compatible major and is not pinned to Node 24 or LTS. Quickstart asks before
installing missing tools. If the existing Homebrew installation is unsuitable,
it offers the direct routes. Once a consented Homebrew operation starts, failure
stops setup for manual recovery rather than silently changing routes. Existing
formulae or link conflicts may need manual attention. Homebrew can install
dependencies; automatic updates and cleanup are suppressed.

When missing tools and a fresh Ballin installation are both needed, Quickstart
previews the selected tools, installation routes, checkout and command paths,
and asks one combined `[y/N]` question. Reruns with an existing checkout ask only
about missing tools. Backup selection stays first; PATH, completion, analytics
and backup destination permissions remain separate. Existing Node.js is never
upgraded automatically during setup.

For Xcode Command Line Tools, Quickstart first checks Apple's Terminal download
list. With one matching package, it runs `sudo softwareupdate --install` for
that exact package, showing native progress. It does not select
macOS upgrades. If no single package is available, it asks separately before
opening `xcode-select --install`, or you can install the tools manually and rerun
Quickstart. A started Terminal installation failure stops for recovery rather
than starting a second installation. Git must actually run before setup proceeds.

Direct routes are Apple's Xcode Command Line Tools for Git, the latest official Node
24 macOS package and GitHub CLI's architecture-specific archive. Node and GitHub
CLI downloads use published SHA-256 checksums. The Node package requires
administrator access and installs commands under `/usr/local/bin`; actual
Node/npm replacement risks name affected paths before consent. Its signature
and publisher are checked before administrator access and again before installation.
A failed operation can leave completed prerequisite work: inspect its output
before retrying.

Managed helper files/links live in `~/.local/share/ballin-quickstart/`. Compatible
Node already first on PATH stays under its current manager. If the original PATH
supplies the selected tools and command directory, Quickstart skips PATH setup.
Otherwise it asks before adding only the needed directories. It never
executes startup files or performs a final PATH recheck. Existing exact lines prevent
duplicate edits, but are not proof the line executes. Unsafe/ambiguous files and
write failures retain specific recovery guidance. Declines leave files unchanged.

When backups are selected, Quickstart reuses active GitHub CLI authentication or
starts gh's native browser sign-in. “Authenticate Git” controls Git credentials;
No still permits gh sign-in. Device codes can be entered in a browser on another
computer. Exported tokens can block login; follow gh's instructions. Quickstart
does not change exported credentials or switch accounts.

After successful destination setup, the optional run-now question runs a backup
and opens its GitHub destination only after capture succeeds. Declining or closing
input skips both. A failed capture/open remains an error. Cancelled/unconfigured
setup never reopens setup or offers run-now.

### Manual PATH setup

If PATH setup was not verified, configure it in the startup file your Terminal
actually reads: normally the matching Zsh
`.zshrc` (including custom ZDOTDIR), or the chosen Bash login file/`.bashrc`.
Add the command directory to PATH: `$(brew --prefix)/bin` when Homebrew is used,
otherwise `$HOME/.local/bin`. For example, without Homebrew:

```zsh
export PATH="$PATH:$HOME/.local/bin"
```

If selected prerequisite tools need Quickstart's managed links, also add
`$HOME/.local/share/ballin-quickstart/bin` to PATH. Keep an existing version
manager's working Node ahead of these fallback links. Open a new Terminal and check
`command -v node git ballin` (and `gh` for backups), then `ballin --help`.
Inspect unexpected earlier commands rather than deleting them blindly. Remove
only the Ballin PATH addition to undo it; prerequisites and other entries remain.

### Answers, input ending and interruption

For yes/no questions, press Enter to use the shown default. Cancelling or closing
input leaves the pending preference unchanged. Closing input during optional
setup ends further Ballin questions, but already approved core work may still
finish. Required prerequisite and
installation questions must be answered to continue; closing input there
stops setup with an error.

If setup fails or is interrupted, earlier approved changes are not rolled back.
Before retrying, inspect any partial checkout and any reported backup destination:
an interrupted remote request may already have completed.

See [guided preference review](optional-capabilities.md#guided-preference-review)
for how confirmed choices are saved when revisiting settings.

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
direct installer does not run `ballin update`, capture a backup, install optional
tools, or change GitHub CLI authentication.

## Commands and services contacted

The linked installation commands download scripts from GitHub. Quickstart's
selected prerequisite routes may also contact Apple's Xcode Command Line Tools service,
Homebrew's formula/bottle services, Node.js releases, or GitHub CLI releases.
The core installer then:

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

The direct installer leaves the first backup for you to run with `ballin backup`;
Quickstart may offer to run it after successful destination setup. A backup
collects the selected allowlisted sources, reads the destination, and saves changes
that pass the conflict checks. See [Backup sources and sensitivity](backup-sources.md).

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
collision offers a checked available suggestion such as `ballin-backups-2`.
Accept it or enter another name; setup never silently reconnects to the existing
repository. A name can become unavailable before creation; follow the reported
error rather than assuming a backup was created.
New repositories start with Issues, Wiki, Projects, and pull requests disabled.
Disabling pull requests requires Administration (write) on the effective GitHub
credential; creation permission alone may be insufficient. If that step fails,
setup reports the created repository for inspection without saving local linkage.
Reconnect leaves existing feature settings unchanged.

Fresh create or reconnect setup asks whether to review sensitive sources for
inclusion, with No as the default. Final confirmation saves the selection. Review
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
Successful new protection gets one concise confirmation during standalone setup;
installation keeps that success silent. Unsupported protection is silent. A permission note or warning about unconfirmed protection is nonfatal
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

## Inspect saved backups

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

For escaped or ambiguous filenames, see
[bundle inspection](backup-design.md#bundle-inspection) for how to select the
original saved path.

These commands inspect saved content without restoring files or executing them.

For local history inspection, clone your backup repository with Git:

```shell
git clone https://github.com/example-user/ballin-backups.git
```

## Health and recovery

For an unexpected problem, run `ballin self-update` first. If it succeeds and the
problem remains, run `ballin doctor` and follow its guidance. If you still need
help, see [Support](../SUPPORT.md). Review output before sharing it and remove
credentials or sensitive backup contents.

If `ballin self-update` fails during setup, the checkout may already be updated;
address the reported setup error before retrying.

For other self-update failures, follow the reported error and recovery guidance
before retrying.

If the installer reports an unsupported Node.js version, switch to a supported
runtime and retry. It includes the detected version when the runtime probe can
identify it. Checkout preparation or update failures link here; review the
reported error before retrying. A failed or incomplete checkout may not
contain a usable inspection helper. Do not run helper code from a checkout you
do not trust. Preserve local configuration and any Git stashes before removing
a checkout.

If Git reports that authentication is required while cloning or fetching this
public repository over HTTPS, GitHub may be applying a
[temporary protection during unusual traffic](https://github.blog/changelog/2026-10-19-some-git-over-https-may-temporarily-require-authentication/).
Wait and retry after the protection is lifted, or
[configure Git authentication](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github)
and retry. This is not a general account requirement for public repositories.

`ballin doctor` treats maintenance-only Ballin as healthy and invokes no `gh`.
Configured repositories are checked for authentication, expected private identity,
supported layout, and coherent readability. This is readiness only: it does not
collect, repair cache permissions, probe writes, or establish backup freshness,
coverage, or successful publication. See [Inspect saved backups](#inspect-saved-backups)
for read-only snapshot inspection.

For a compact local snapshot when troubleshooting the installed checkout, run
its read-only inspection helper:

```shell
node "$HOME/.ballin-scripts/test/inspect.ts"
```

It reports runtime versions, the installed commit, working-tree status, and
selected backup configuration flags without printing destination identifiers
or config contents. Review the output before sharing it. This is narrower than
`ballin doctor`, which checks Ballin's overall managed-environment health and,
when configured, remote backup readability. The helper does not verify remote
repository identity or access, backup contents or freshness, or complete system
health. Some results may be unavailable; if Git filters are configured, it
declines to check working-tree status rather than execute them. It requires a
compatible Node.js runtime (24.12 or newer) and the installed checkout at the
default path above, including the helper file.

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

Prerequisites, Quickstart helper files, and PATH additions remain in place.

When analytics remain enabled, uninstall can send its normal final top-level
command event using state captured before local deletion.

## Manual removal

If the command cannot run, inspect the potential link locations first:
`~/.local/bin/ballin`, `/opt/homebrew/bin/ballin`, `/usr/local/bin/ballin`, and
`$(brew --prefix)/bin/ballin` for a custom Homebrew prefix. Remove only links
whose target is `~/.ballin-scripts/bin/ballin`, then remove
`~/.ballin-scripts`. Remote backups and GitHub CLI authentication require separate
manual action if you also want to remove them.
