# Installation and removal

*User guide to installing, configuring, troubleshooting, and removing Ballin.*

Ballin can be installed for maintenance without configuring backups. Git and a
supported Node.js version are the only prerequisites for the installer. Backups
and integrations such as Homebrew are optional. Ballin has no runtime npm
dependencies.

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
BALLIN_SHELL_PID=$$ BALLIN_SHELL_HOME="$HOME" BALLIN_SHELL_CONFIGURED="${SHELL-}" BALLIN_SHELL_ZDOTDIR_SET="${ZDOTDIR+x}" BALLIN_SHELL_ZDOTDIR="${ZDOTDIR-}" bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
```

A fresh install checks Git and Node.js, links to installation details, and asks for `y/N`
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

For the usual zsh setup, the installer offers `~/.zshrc` directly when its
original-shell evidence matches. PATH and completion require separate permissions.
To enable completion later, add this line near the end of that file:

```zsh
[[ -r "$HOME/.ballin-scripts/completions/_ballin" ]] && source "$HOME/.ballin-scripts/completions/_ballin"
```

Open a new terminal or run `source ~/.zshrc`. Once this line is present,
`ballin self-update` refreshes the completion scripts; reload the startup file or
open a new terminal to use the updated command list.

If you use `ZDOTDIR`, use the `.zshrc` in that directory instead. The documented
launch commands preserve the original shell's location settings. Setup verifies
that they came from the invoking Zsh session without executing startup scripts.
PATH and completion each check independently. A missing `.zshrc` is normal.
If setup cannot establish an absolute location, it asks for the directory or
`skip`. Plain invocations without the captured settings also use this fallback.

This is a location hint: a late ZDOTDIR change may not identify the file loaded
earlier, and no check proves what every future shell will execute. Inspect your
startup chain if you changed it. An existing exact activation is not appended
again. To disable completion, remove only Ballin's guarded activation line;
reload the file or open a new Terminal. Self-update refreshes the completion
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
that line manually with the displayed command using LF line endings.

## Local effects

### Quickstart helper

The [quickstart helper](quickstart.md) reuses Git, compatible Node.js, and GitHub
CLI. It requires macOS 13.5 or newer and zsh or Bash. Homebrew is optional.

[View the setup script](../quickstart.sh).

Quickstart first asks whether to set up backups. No still installs Ballin for
maintenance; it omits backup-only GitHub CLI discovery/installation, sign-in,
destination setup and run-now. Existing tools, accounts and backups remain.
Later `ballin backup setup` checks current prerequisites and GitHub access.

Compatible existing Git, Node.js and (when selected) GitHub CLI are reused.
Node must meet the [package requirement](../package.json), currently >=24.12;
a newer compatible major is accepted. An incompatible active Node, or an
unlinked/manager-owned installation that makes a new install ambiguous, requires
manual attention. Quickstart never upgrades or switches an existing incompatible Node,
installs nvm, or bootstraps Homebrew. A manager directory alone is not a Node
installation. Follow the identified installation method, or the
[Node guidance](optional-capabilities.md#nodejs), then rerun Quickstart.

For genuinely missing tools, a suitable native existing Homebrew installation
is preferred for Git, Node and GitHub CLI. The Node route uses ordinary
`brew install node`: Homebrew's **default formula**, which may move to a newer
compatible major and is not pinned to Node 24 or LTS. Metadata/dependency and
bottle checks happen only after prerequisite consent. Unknown layouts,
unsupported architectures and incomplete prerequisites use the direct routes;
a failed consented Homebrew preflight/install stops for manual recovery rather
than silently changing routes. Existing/pinned/unlinked formulae, link conflicts
and a plan that could change existing Node require manual attention. Homebrew
can install ordinary dependencies; cleanup and automatic updates are suppressed.

Direct routes are Apple's Command Line Tools for Git, the latest official Node
24 macOS package and GitHub CLI's architecture-specific archive. Downloads use
published SHA-256 checksums. Node's Apple signature and publisher are checked
before administrator access; the privileged stage rechecks its private package.
Actual Node/npm replacement risks name affected paths before consent. A failed
operation can leave completed prerequisite work: inspect its output before retry.

Managed helper files/links live in `~/.local/share/ballin-quickstart/`. Compatible
Node already first on PATH stays under its current manager. Quickstart preserves
the entry PATH and its ordered search (including relative/empty entries anchored
to the entry working directory). If that PATH supplies the selected tools and
command directory, it skips startup inspection/editing. Otherwise it asks before
adding only the needed helper/command directories. It never sources startup files,
scans `.zprofile` or performs a final PATH recheck. Existing exact lines prevent
duplicate edits, but are not proof the line executes. Unsafe/ambiguous files and
write failures retain specific recovery guidance. Declines leave files unchanged.

When backups are selected, Quickstart reuses active GitHub CLI authentication or
starts gh's native browser sign-in. “Authenticate Git” controls Git credentials;
No still permits gh sign-in. Device codes can be entered in a browser on another
computer. Exported tokens can block login; follow gh's instructions. Quickstart
does not change exported credentials or switch accounts.

After successful destination setup, the optional run-now question runs a backup
and opens its GitHub destination only after capture succeeds. No or EOF silently
skips both. A failed capture/open remains an error. Cancelled/unconfigured setup
never reopens setup or offers run-now.

### Manual PATH setup

Use the startup file your Terminal actually reads: normally the matching Zsh
`.zshrc` (including custom ZDOTDIR), or the chosen Bash login file/`.bashrc`.
Add the command directory to PATH: `$(brew --prefix)/bin` when Homebrew is used,
otherwise `$HOME/.local/bin`. For example, without Homebrew:

```zsh
export PATH="$PATH:$HOME/.local/bin"
```

If selected prerequisite tools need Quickstart's managed links, also prepend
`$HOME/.local/share/ballin-quickstart/bin`. Keep an existing version manager's
working Node ahead of fallback links. Open a new Terminal and check
`command -v node git ballin` (and `gh` for backups), then `ballin --help`.
Inspect unexpected earlier commands rather than deleting them blindly. Remove
only the Ballin PATH addition to undo it; prerequisites and other entries remain.
No/uncertain PATH setup ends with “PATH setup wasn’t verified” and this manual
link, rather than also claiming successful setup.

### Answers, input ending and interruption

Ballin yes/no questions accept y/yes and n/no, ignoring case and surrounding
whitespace. Invalid completed answers repeat the question; Enter uses its shown
default. Paths, names, menus and native tool prompts keep their own rules.
An incomplete answer at EOF grants no permission and never saves a silent No.
Optional EOF ends further Ballin questions, preserves the unanswered setting and
finishes already authorized core work. Before installation consent, it ends
Quickstart without claiming installation. Required prerequisite/install consent
EOF is an error; the CLT readiness pause also requires a completed answer and
an actual readiness check.

Control-C remains an interruption (normally 130), distinct from EOF and No.
Pending choices are not saved, later setup actions stop, and earlier approved
changes remain. There is no rollback or guarantee all descendants stop at once.
A remote request may have completed: inspect the reported destination before
retrying. Standalone `ballin setup` saves each confirmed preference sequentially;
existing-backup settings review saves its reviewed pair together. EOF cancels
that pending review normally; explicit No retains the command's cancellation
behavior. Actual read/save/auth/access/cache/protection errors remain visible.
`ballin uninstall` leaves prerequisites, helper files, startup additions,
authentication and remote backups in place; see [uninstall](#uninstall).

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

The commands above download their scripts from GitHub. Quickstart also downloads
Ballin's startup-location helper when PATH setup is needed. Its selected
prerequisite routes contact Apple's Command Line Tools service, Homebrew's
formula/bottle services, Node.js releases, or GitHub CLI releases. The installer then:

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

## Health and recovery

If the installer reports an unsupported Node.js version, switch to a supported
runtime and retry. It includes the detected version when the runtime probe can
identify it. Checkout preparation or update failures link here; review the
reported error before retrying. A failed or incomplete checkout may not
contain a usable inspection helper. Do not run helper code from a checkout you
do not trust.

`ballin doctor` treats maintenance-only Ballin as healthy and invokes no `gh`.
Configured repositories are checked for authentication, expected private identity,
supported layout, and coherent readability. This is readiness only: it does not
collect, repair cache permissions, probe writes, or establish backup freshness,
coverage, or successful publication.

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
