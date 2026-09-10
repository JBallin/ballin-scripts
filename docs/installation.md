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

If requested backup setup fails, the checkout, configuration, command link, and
eligible analytics state remain installed. The installer exits nonzero and
prints the same command as the retry path. If creation or initialization is
ambiguous, inspect the reported repository and completed stage deliberately;
do not blindly create again. A confirmed marker followed by local-save failure
can be recovered through explicit reconnect. Ballin never rolls back remote
history automatically.

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
- for new repository setup, checks the effective personal GitHub.com credential
  and selected destination, then after confirmation either reconnects or creates
  a private repository containing only the Ballin marker;
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

New setup offers distinct **create** and **reconnect** choices and defaults to
`ballin-backups`. The optional argument is a repository name, not a URL or owner.
Backups belong to the authenticated personal GitHub.com account. Setup shows
that account and the complete destination before final confirmation. A missing
or inaccessible reconnect candidate never causes replacement creation; a create
collision requires an explicit different name or reconnect choice.

Ballin uses the effective credential through `gh api ... user`; an environment
token can take precedence over a stored login. Ballin never logs in, switches
accounts, or broadens scopes automatically. Authenticate with
`gh auth login --hostname github.com` yourself if needed. Creation/publication
require repository write access; reconnect and recovery need only the
corresponding read access. Branch restrictions can still reject writes.

Fresh create or reconnect setup asks for one default-off choice covering raw
configuration and pipx metadata. Reconnect fully inspects the existing backup
before asking. Declining performs no sensitive-source discovery. Selecting it
reviews logical paths, resolved regular-file targets (including symlinks outside
`HOME`), and missing or unavailable sources. pipx is described separately. Review
reads no raw contents and runs no collectors; access or resolution errors stop
setup. See
[Source review](backup-sources.md#repository-inclusion).

Final confirmation covers destination and source selection. Declining or EOF,
including an unsubmitted partial `y`, cancels before destination, consent, cache,
or remote writes. Ordinary configuration defaults may have been filled;
destination and consent defaults are deferred until confirmation. After approval,
Ballin revalidates the reconnect candidate or creates and confirms a marker-only
repository, invalidates untrusted caches, then atomically saves verified linkage,
reviewed consent, and eligible preferences. It never seeds a comparison base
from recovered remote content.

`backup.repository` stores opaque repository and owner IDs, the mutable name,
and the initially selected default branch. Renames are resolved by ID;
configured `setup` revalidates that identity and preserves local sensitive-source
and automatic-backup choices. An explicit name must identify that same backup.
Changing destinations requires disconnect. Wrong ownership, public visibility,
unsupported contents/state, or a missing selected branch fail closed.

Reconnect restores only [portable preferences](backup-design.md#portable-preferences).
Original local leaves win, including default-valued or invalid ones; admitted
remote values may replace defaults created during setup. Destination, sensitive
consent, automatic-backup choices, and unknown settings are never restored.
An eligible analytics opt-out is applied before installer analytics initialization.
Saved dotfiles and packages are never applied or executed.

After saving a newly configured backup, Ballin asks whether updates should run
backups automatically. The `[Y/n]` prompt accepts Enter, `y`, or `Y` as `"true"`;
other answers or unanswered EOF save `"false"`. A partial `y` followed by EOF
also saves `"true"`. If that preference save fails, the destination remains
configured and the partial result is reported. Change it later with
`ballin config set update.backup true` or `false`.

Creation uses GitHub's initialized private repository, then one conditional
commit replaces only its checked setup-generated README with the Ballin marker.
Remote creation can remain completed if a later step fails. Cache invalidation
can remain completed even when local persistence fails. Reconnect provides no
authority to overwrite different saved content. Older full-config snapshots
receive no special conflict exception.

Existing configured Gists retain backup/read/open/readiness and required host
repair through `ballin backup setup`. Setup reports that the existing Gist remains
configured; it does not migrate or replace it with a repository. The internal
installer compatibility command cannot create or adopt Gists. Migration and Gist
retirement belong to
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
