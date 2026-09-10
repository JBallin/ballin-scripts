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

Remote/cache comparison uses exact bytes. Older full-config or broader
projected `ballin_config` snapshots receive no special overwrite or conflict
exception when they differ from the current projection.

## Portable preferences

The [approved v1 policy in #332](https://github.com/JBallin/ballin-scripts/issues/332)
records the durable contract. Export and restoration use separate explicit
allowlists, independent of bundled defaults:

| Leaf | Export | Restore |
| --- | --- | --- |
| `update.cleanup` | Boolean, as described below | Boolean, subject to local precedence |
| `update.selfUpdate` | Boolean, as described below | Boolean, subject to local precedence |
| `update.softwareupdate` | Boolean, as described below | Boolean, subject to local precedence |
| `update.npm` | Boolean, as described below | Boolean, subject to local precedence |
| `update.nvm` | Boolean, as described below | Boolean, subject to local precedence |
| `analytics.enabled` | Only exact string `"false"` | Only exact string `"false"`, subject to local precedence |
| `update.backup` | No | No; local setup choice under #344 |
| `backup.id`, `backup.host` | No | No; independently selected destination wins |
| Sensitive-source consent | No | No; local review owned by #333 |
| Analytics installation identity | No | No |
| Unknown/custom/future settings | No | No; existing local values remain intact |

For the five admitted update leaves, accept native JSON booleans and exact
`"true"`/`"false"` strings; export and restore canonical strings. Omit absent
export leaves without filling defaults. Invalid admitted local values or a
malformed local `update` section fail the whole projection with a key-only
diagnostic. No partial `ballin_config` is emitted, and staged successes are
discarded before remote snapshot inspection. Excluded leaves are not validated
by projection: invalid `update.backup` or an excluded `backup` section does not
block an otherwise valid export.

Analytics portability accepts only exact string `"false"`, with no boolean
coercion. Absent, invalid, native-boolean, and `"true"` values are omitted or
ignored. Remote data never enables analytics or restores an installation
identity. An eligible restored opt-out is applied before installer analytics
initialization; otherwise the bundled default, first-run notice, and
environment opt-outs still apply.

Setup captures local configuration before creating or refreshing defaults.
An admitted leaf already present is authoritative, even if default-valued or
invalid; remote data does not replace or repair it. Defaults created during
that setup invocation can be replaced by admitted remote preferences. With
neither an existing choice nor an admitted remote value, retain defaults.
Restoration changes later preferences only; it does not execute updates,
install tools, or alter integration ordering and failure handling.

The setup preflight rejects malformed local JSON, a non-object root, or present
non-object `update`, `analytics`, or `backup` sections before refresh. Missing
sections are allowed. This prevents malformed analytics configuration from
being replaced with enabled defaults without changing general config migration.
Malformed JSON or a non-object remote snapshot aborts adoption; malformed remote
sections and invalid, absent, or excluded leaves are ignored independently.
An absent snapshot preserves local settings and defaults. Diagnostics do not
print rejected values or arbitrary remote content.

`update.backup` remains local-only, including when reading older snapshots.
Its maintenance-only default is `"false"`. Preserve #344's newly configured
backup prompt, existing-local-choice behavior, and post-destination save-failure
handling described in [Installation](installation.md#optional-backup-and-adoption).
Migration of a configured installation retains its local automatic-backup
choice; a replacement installation establishes its own choice during setup.

## Shared inclusion policy

Noninteractive selection primitives prepare for private-repository onboarding
in [#333](https://github.com/JBallin/ballin-scripts/issues/333) and reviewed
migration in [#334](https://github.com/JBallin/ballin-scripts/issues/334).
Current Gist capture explicitly selects all current sources, including raw
files and pipx. No inclusion setting, interactive review helper, or new public
command is added by #332. Gist runtime retirement belongs to #334.

The canonical definitions own fixed `inventory`, `sensitive`, and `preferences`
inclusion groups, separate from tool-oriented categories: 12 inventory sources,
15 sensitive sources, and one projected preferences snapshot.
`SnapshotDefinition.name` remains the durable identity and stored/read name.
The observation entrypoint accepts one native boolean, `includeSensitive`,
default false; non-boolean supplied input fails before discovery. It is an
internal argument, not a persisted setting. Inventory and preferences form the
fixed baseline. Unknown groups are excluded; future sources/groups require an
explicit inclusion and sensitivity review.

Policy-aware observation gates discovery itself. `excluded-by-policy` carries
the definition and reason, without a source or collector; collection records
a skipped result. It remains distinct from absent, unavailable, failed
discovery, and failed collection. Consumers must not stat, resolve, read, or
probe excluded sensitive sources just to verify them, including pipx executable
discovery. Exclusion does not delete existing remote/cache data or make retained
content a current capture.

#333 owns the local consent field, its parsing/persistence, and the actual
repository review. It will introduce one accurately named preference, default
off, which is never exported or restored. #332 introduces no persisted
sensitive-source setting and reserves no key. Unknown local settings remain
preserved.
There are no restored proposals, pending-consent fields, or removal migration.
See the [planned source review](backup-sources.md#planned-repository-inclusion).

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
