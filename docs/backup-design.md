# Backup design

This guide records the safety model behind `ballin backup`. User behavior and
conflict recovery are documented in
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts).

## Consistency model

- Stage every snapshot before reading or changing remote state. Collector or
  remote-read failures abort without changing Gist or cache contents.
- Treat the cache as the last remote state observed by this machine. Compare
  cached, remote, and staged content—including file presence—and abort every
  conflict without changing those contents.
- Treat cache ownership as unproven whenever no destination is configured.
  Enabling backup from that state invalidates `.backup-cache` before destination
  persistence; the cache format is deliberately not extended with destination
  metadata in this design.
- Send safely changed files in at most one unsplit request, then promote caches
  and print results only after the remote outcome is known.
- Report cache-promotion failures after remote success without success markers;
  the next run re-reads remote state and reconciles stale cache entries.

The presence-aware decision cases are covered as an executable table in
[`test/backup.test.ts`](../test/backup.test.ts).

During adoption, the host selected in the current setup and the Gist ID whose
marker was validated are authoritative. A restored `ballin_config` contributes
only admitted portable preferences where no local leaf existed before setup
filled defaults. Existing local choices and unknown settings are retained;
remote destination and unknown fields are ignored. The restored settings
and authoritative destination are committed together; a failed commit preserves
the prior unconfigured config. An already-invalidated cache remains removed.

The config collector projects the explicit export allowlist before producing
`ballin_config`. Invalid local update/inclusion preferences fail collection,
so staged successes are discarded before remote snapshot inspection. Remote/cache
comparison still uses exact bytes: a legacy whole-config snapshot receives no
special overwrite or conflict exception.

## Shared inclusion policy

The canonical definitions own fixed `inventory`, `detailed`, `raw`, and
`preferences` inclusion groups, separate from tool-oriented categories.
`SnapshotDefinition.name` remains the durable identity and stored/read name.
The selection defaults to inventory and projected preferences, with raw and
detailed inclusion controlled by two default-off preferences. Unknown groups
are excluded; future categories require a separately reviewed default-off
decision.

Policy-aware observation gates discovery itself. `excluded-by-policy` carries
the definition and reason, without a source or collector; collection records
a skipped result. It remains distinct from absent, unavailable, failed
discovery, and failed collection. Consumers must not inspect excluded raw
sources just to verify them. Exclusion does not delete existing remote/cache
data or make retained content a current capture.

The shared review helper takes original local preferences, optional restored
proposals, and a local source context. It returns confirmed selection,
cancellation, or failure without persisting anything. Raw review follows
selected symlinks and displays logical and resolved sources; it never reads
contents or executes collectors. Callers own the destination/config commit.

Current Gist capture explicitly keeps its existing source selection. #333
connects shared selection/review to repository onboarding, and #334 consumes
it for reviewed migration and removes the Gist path. No permanent legacy mode
or richer Gist setup is introduced. See the user-facing
[source review contract](backup-sources.md#shared-inclusion-policy).

## Local cache permissions

Before authentication or collection, a configured backup restricts existing
cache directories to `0700` and regular files to `0600`, including inactive
snapshots and leftover staging directories. Permission changes remain in place
if the run later fails; unchanged cache contents do not imply unchanged modes.
Symbolic links and unsupported entry types are rejected without following them.
An error securing the cache stops the run before any remote request.

A missing cache is created only during promotion, with mode `0700` explicitly
enforced. Copies are restricted to `0600` inside the private staging directory
before any rename replaces a final entry. Copy or chmod failure prevents
promotion and removes that staging directory. Source permissions and the
process umask are unchanged.

These are POSIX mode protections for Ballin-owned files on macOS and Linux.
They do not manage ACLs, isolate hardlink aliases, or protect against concurrent
path replacement through writable ancestors.

## GitHub constraints

GitHub's [Gist update API](https://docs.github.com/en/rest/gists/gists#update-a-gist)
supports multiple changed files while leaving omitted files unchanged. Ballin
sends changed content only and never sends deletion entries. For
[truncated files](https://docs.github.com/en/rest/gists/gists#about-gists), it
requests raw content and validates the byte count before comparing files.

The endpoint documents no transactional or conditional PATCH guarantee and no
applicable universal payload maximum. Ballin therefore fails closed on rejected
or uncertain requests and supports one active writer per Gist. It does not
synchronize, merge, automatically resolve changes, or eliminate the read/write
race. Requests use the configured GitHub or Enterprise host through
[`gh api`](https://cli.github.com/manual/gh_api).
