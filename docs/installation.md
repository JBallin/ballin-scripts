# Installation and removal

Ballin can be installed for maintenance without configuring backups. Git and a
supported Node.js version are the only prerequisites for the installer. Gist
backup, Homebrew, and the other integrations are optional.

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

The core installation completes before Ballin offers optional Gist backup.
Declining backup setup makes no GitHub CLI, authentication, or Gist calls. Run
this later to create or adopt a destination without reinstalling:

```shell
ballin backup setup
```

If requested backup setup fails, the checkout, configuration, command link, and
eligible analytics state remain installed. The installer exits nonzero and
prints the same command as the retry path. If Gist creation succeeds but Ballin
cannot persist `backup.id`, local setup remains unconfigured, but the newly
created remote secret Gist may remain. Inspect your Gists and remove that remote
destination manually if it is not needed; Ballin does not attempt an automatic
remote rollback.

## Local effects

The installer can create or change:

- `~/.ballin-scripts/`, a Git checkout of `ballin-scripts`. A refresh fetches
  and merges `origin/main`. If checkout or merge recovery is needed, Ballin can
  stash tracked and untracked changes in this checkout.
- `~/.ballin-scripts/ballin.config.json`. A new file starts from the bundled
  defaults. A refresh adds missing known settings. Adopting a backup can restore
  compatible settings and unknown keys from `ballin_config` as described
  below.
- `~/.ballin-scripts/.analytics/install-id` when analytics are enabled and the
  environment has not opted out. Installation creates only the local random
  ID; it sends no analytics event. Later instrumented commands can send the
  payload documented in [Analytics](analytics.md).
- `<bin>/ballin`, a symbolic link to `~/.ballin-scripts/bin/ballin`. `<bin>` is
  `$(brew --prefix)/bin` when `brew` is available, otherwise
  `~/.local/bin`. The selected directory must already be on `PATH`.
- `~/.ballin-scripts/.backup-cache` only after a successful backup run. It is
  derived comparison state, not the backup destination or an enablement flag.

Before creating the command link, setup removes an existing non-directory
target at `<bin>/ballin`. It refuses to replace a directory. A repository
refresh can replace checkout files through the Git merge. Config migration can
add bundled defaults; successful adoption can replace saved preferences.

Temporary Gist marker and staged config files are removed after setup. The
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
- when backup setup is requested, checks `gh` authentication for the selected
  host and either reads an existing Gist marker and optional `ballin_config`, or
  creates a secret Gist containing only the Ballin marker;
- sends no analytics request during installation. Later instrumented commands
  can contact the endpoint described in [Analytics](analytics.md).

The first `ballin backup` is a separate command. It collects the current
allowlisted sources, reads relevant Gist state, and writes safely changed
snapshots. See [Backup sources and sensitivity](backup-sources.md).

## Optional backup and adoption

Backup is configured only when `backup.id` contains a non-empty Gist ID.
Missing, null, blank, and legacy string `"null"` IDs all mean maintenance-only
Ballin. Non-string IDs are invalid configuration: doctor, setup, backup, and an
enabled update backup stage fail before GitHub work until `backup.id` is fixed
to null or a non-empty string. `backup.host` records which GitHub or GitHub
Enterprise host to use.

Setup creates a secret Gist. Secret means unlisted, not strongly private:
anyone with the URL or ID can view it. Shell, Git, and editor files can contain
credentials, tokens, private URLs, paths, or other sensitive content added by
the user. Ballin is not a secrets manager and does not scan or redact allowed
files. Review [Backup sources and sensitivity](backup-sources.md) and protect
the Gist URL and ID.

When adopting an existing backup, setup validates the Ballin marker using the
host selected in the current setup flow. That selected host and the
marker-validated Gist ID are authoritative. A restored `ballin_config` can
contribute update preferences, analytics opt-out, and other settings, but its
own `backup.host` and `backup.id` cannot select or redirect the destination.
Restored settings and the authoritative destination become live in one config
commit. A restoration or final-commit failure leaves the prior config active
and unconfigured. Setup retains local settings only when a successful Gist file
listing establishes that `ballin_config` is absent. A failed, interrupted, or
unreadable listing or snapshot read stops adoption instead of silently skipping
restoration.

If a configured ID has a malformed host, `ballin backup setup` asks for a
replacement but does not persist it immediately. Setup authenticates to the
replacement host and confirms that the retained Gist contains Ballin's marker.
Only then does it save the host and preserve the configured destination's cache.
A missing or wrong Gist leaves the malformed host and cache unchanged.

`.backup-cache` is the last remote base observed by this machine, but its format
does not identify a destination. Ballin therefore invalidates any cache before
an unconfigured installation creates or adopts a destination. If invalidation
fails, setup stops before creation, restoration, or destination persistence.
After adoption, a missing cache uses the normal fail-closed comparison rules:
if local and remote snapshot content differ, the next backup reports a conflict
instead of choosing a winner. Ballin does not restore the invalidated cache when
later setup steps fail.

Once a destination is configured, installer refresh, self-update, doctor, and
setup validation preserve its cache. Resetting config returns Ballin to the
maintenance-only state and does not delete the old remote Gist. A later setup
attempt invalidates the now-unproven local cache before configuring a
destination.

## Health and recovery

`ballin doctor` treats maintenance-only Ballin as healthy. Verbose output shows
one `INFO` row for optional Gist backup and names `ballin backup setup`; it does
not run `gh`. With a non-empty backup ID, doctor checks the configured host,
`gh`, authentication, and Gist readability, and those failures affect overall
health. Malformed or unreadable core configuration remains an error.

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
does not delete a remote Gist, its revision history, or GitHub CLI credentials.
When analytics remain enabled, uninstall can send its normal final top-level
command event using state captured before local deletion.

## Manual removal

If the command cannot run, inspect the potential link locations first:
`~/.local/bin/ballin`, `/opt/homebrew/bin/ballin`, `/usr/local/bin/ballin`, and
`$(brew --prefix)/bin/ballin` for a custom Homebrew prefix. Remove only links
whose target is `~/.ballin-scripts/bin/ballin`, then remove
`~/.ballin-scripts`. Remote Gists and GitHub CLI authentication require separate
manual action if you also want to remove them.
