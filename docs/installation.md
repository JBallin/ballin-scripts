# Installation and removal

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
before cloning or making installation changes. No or end-of-file exits
successfully without cloning. Refreshing an existing installation does not
repeat this confirmation.

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

## Local effects

The installer can create or change:

- `~/.ballin-scripts/`, a Git checkout of `ballin-scripts`. A refresh fetches
  and merges `origin/main`. If checkout or merge recovery is needed, Ballin can
  stash tracked and untracked changes in this checkout.
- `~/.ballin-scripts/ballin.config.json`. A new file starts from the bundled
  defaults. A refresh adds missing known settings. Reconnecting to a backup can
  recover supported Ballin preferences; existing local choices and custom
  settings are preserved.
- `~/.ballin-scripts/.analytics/install-id` when analytics are enabled and the
  environment has not opted out. Installation creates only the local random
  ID; it sends no analytics event. Later instrumented commands can send the
  payload documented in [Analytics](analytics.md).
- `<bin>/ballin`, a symbolic link to `~/.ballin-scripts/bin/ballin`. `<bin>` is
  `$(brew --prefix)/bin` when `brew` is available, otherwise
  `~/.local/bin`. The selected directory must already be on `PATH`.
- `~/.ballin-scripts/.backup-cache` during confirmed-state cache promotion. It is
  derived comparison state, not the backup destination or an enablement flag.

Before creating the command link, setup removes an existing non-directory
target at `<bin>/ballin`. It refuses to replace a directory. A repository
refresh can replace checkout files through the Git merge. Config migration can
add bundled defaults.

Private transport and staged config files are removed after setup. The
installer does not run `ballin update`, collect snapshots, perform the first
backup, install optional tools, or change GitHub CLI authentication.

## Commands and services contacted

The command shown above downloads `install.sh` from GitHub. The installer then:

- runs local Git and Node.js prerequisite checks;
- clones the GitHub repository on a fresh install, or fetches `origin/main` for
  an existing checkout;
- runs `brew --prefix` only when Homebrew is present, to select a command-link
  directory;
- makes no GitHub CLI or Gist calls when optional backup setup is declined;
- during repository backup setup, checks the personal GitHub.com account
  currently used by `gh` and the selected destination, then after confirmation
  either reconnects to an existing backup or creates a private backup repository;
- sends no analytics request during installation. Later instrumented commands
  can contact the endpoint described in [Analytics](analytics.md).

The first `ballin backup` is a separate command. It collects the current
selected allowlisted sources, reads the destination, and saves changes that pass
the conflict checks. See [Backup sources and sensitivity](backup-sources.md).

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

Ballin uses your existing `gh` authentication. It does not log in, switch
accounts, or expand permissions on your behalf. If authentication is missing,
run `gh auth login --hostname github.com`. Creating or updating the repository
requires write access; reconnect and recovery need only read access. If Ballin
shows an unexpected account, check whether an environment token is overriding
your saved `gh` login.

Fresh create or reconnect setup asks for one default-off choice covering raw
configuration and pipx metadata. Reconnect fully inspects the existing backup
before asking. Declining performs no sensitive-source discovery. Selecting it
reviews logical paths, resolved regular-file targets (including symlinks outside
`HOME`), and missing or unavailable sources. pipx is described separately. Review
reads no raw contents and runs no collectors; access or resolution errors stop
setup. See
[Source review](backup-sources.md#repository-inclusion).

Final confirmation covers the destination and source selection. If you decline,
Ballin makes no backup-specific changes. If you approve, it revalidates the
destination, creates or reconnects to the repository, and saves the destination,
sensitive-source choice, and any supported preferences recovered from the
backup.

Renaming the repository on GitHub does not break the connection: Ballin continues
to recognize the same backup. To switch to a different repository, disconnect
first and run `ballin backup setup` again. Ballin backup repositories must be
private, belong to the personal GitHub.com account used for setup, and meet
Ballin's other support requirements.

Reconnect restores only [portable preferences](backup-design.md#portable-preferences).
Existing local choices take precedence over values from the backup, although
supported backup values can replace defaults added during the current setup. The
destination, sensitive-source consent, automatic-backup choice, and unsupported
or unknown settings remain local. If the backup contains the supported analytics
opt-out, Ballin applies it before initializing analytics. Reconnect does not
apply saved dotfiles or install saved packages.

After creating or reconnecting a backup, Ballin asks whether `ballin update`
should run backups automatically (default: yes). The choice is stored in
`update.backup`; change it later with `ballin config set update.backup true` or
`false`. If Ballin cannot save the choice, the backup destination remains
configured, and Ballin reports the partial result.

Existing configured Gists retain compatibility temporarily. `ballin backup setup`
reports that the existing Gist remains configured; it does not migrate or replace
it with a repository. Gist retirement after repository cutover is tracked in
[#334](https://github.com/JBallin/ballin-scripts/issues/334); backup verification
belongs to [#336](https://github.com/JBallin/ballin-scripts/issues/336).

## Disconnect

```shell
ballin backup disconnect
```

Disconnect atomically clears both repository and legacy Gist associations and
sets `update.backup="false"`, then removes `.backup-cache`. It preserves sensitive
consent, legacy host, and unrelated preferences. It requires no authentication
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

If installation stops after cloning but before core setup, fix the reported
PATH, filesystem, or configuration problem and rerun the installer. Refreshes
reuse the existing checkout. If optional backup setup alone fails, use the
already-installed maintenance commands and retry with `ballin backup setup`.

## Uninstall

Run:

```shell
ballin uninstall
```

Uninstall removes Ballin-owned command symlinks and recursively deletes
`~/.ballin-scripts`, including config, analytics identity, and backup cache. It
does not delete a remote backup, its revision history, or GitHub CLI credentials.
When analytics remain enabled, uninstall can send its normal final top-level
command event using state captured before local deletion.

## Manual removal

If the command cannot run, inspect the potential link locations first:
`~/.local/bin/ballin`, `/opt/homebrew/bin/ballin`, `/usr/local/bin/ballin`, and
`$(brew --prefix)/bin/ballin` for a custom Homebrew prefix. Remove only links
whose target is `~/.ballin-scripts/bin/ballin`, then remove
`~/.ballin-scripts`. Remote backups and GitHub CLI authentication require separate
manual action if you also want to remove them.
