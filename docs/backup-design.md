# Backup design

**Audience:** Maintainers

This guide records the safety model behind `ballin backup`. User behavior and
conflict recovery are documented in
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts).

## Architecture and destination identity

`commands/backup_repository.ts` is a concrete storage module. It localizes GitHub
identity, trees/blobs, revisions, publication and confirmation. Commands/setup
consume canonical names, exact bytes, complete/incomplete inspection outcomes,
finite failure reasons, and a revision handle. There is no backend/provider
registry. `commands/backup.ts` shares staging, three-way comparison, and private
cache promotion with the bounded configured-Gist route.

Local `backup.repository` is null or `{ id, ownerId, name, branch }`: opaque
GitHub node IDs establish identity, the mutable name locates REST resources,
and the initial default branch remains selected. The effective `gh api ... user`
account must be the personal GitHub.com owner. Stable-ID resolution revalidates
owner, private visibility, supported state, selected branch, and marker. A rename
cannot switch destinations. An explicit setup name must resolve to the same
identity when configured. Simultaneously populated or malformed repository/Gist
associations fail without fallback.

Repository contents use a flat layout. Current snapshots use the exact filenames
defined by Ballin. `.ballin-backup.json` is the repository marker, and newly
created repositories initially include an explanatory root `README.md`. The
marker has these exact UTF-8 bytes and one final newline:

```json
{"format":"ballin-backup","version":1,"repositoryId":"…","ownerId":"…"}
```

Marker IDs must match the validated destination. Ballin reserves `README.md` for
explanatory content; the file is not backup state and does not participate in
repository identity, snapshot identity, or preference recovery. Ballin
classifies root filenames as current snapshots, reserved Ballin files, retired
snapshot names, or unexpected files. Retired snapshot files and unexpected
regular files are preserved without reading their contents.

Directories, workflows, executable modes, symlinks, submodules, duplicate paths,
and other unsupported entries fail closed. There are no timestamps, device IDs,
checkpoint receipts, or configurable layouts.

Repository bootstrap is deliberately strict. Ballin creates a private,
auto-initialized repository through `/user/repos` (`private:true`,
`auto_init:true`) and accepts only GitHub's expected seed: a single root commit
containing one regular `README.md`. Against that exact head, one conditional
commit adds `.ballin-backup.json` and replaces the seed README with Ballin's
guide. Ballin verifies the resulting tree and marker before saving the repository
as the configured destination. Later backups leave `README.md` untouched and
ignore it as backup state. If initialization cannot be confirmed safely, Ballin
stops for inspection rather than risk creating a duplicate repository.

## Managed-branch protection

Personally owned private backup repositories require
[GitHub Pro for repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#who-can-use-this-feature).
Normal `gh` OAuth credentials for the personal owner support repository creation
and publication. The conservative fine-grained-token path uses the same personal
resource owner, all repositories, `Administration: write`, and `Contents: write`.
Administration is needed to create missing protection; routine publication uses
contents permission, and already protected read/reconnect paths do not require
administration.

After the bootstrap commit and its tree/marker readback succeed, setup establishes
one active repository branch ruleset scoped only to
`refs/heads/<selected branch>`. The ruleset contains exactly `deletion` and
`non_fast_forward`, with no bypass actors; it adds no pull-request, review,
status-check, update restriction, or other collaboration gate. Ballin verifies
the named ruleset's exact branch target and rules before saving local linkage.
Ordinary `createCommitOnBranch` publication remains a conditional fast-forward
using `expectedHeadOid`; Ballin never forces, bypasses, or substitutes protection
for three-way reconciliation.

Protection is a read-before-write setup transaction. Ballin lists
repository-level branch rulesets, accepts one exact ruleset with the fixed name
`Ballin backup branch protection`, and creates it only when that name is absent.
A nominal creation response is verified independently through the returned
ruleset ID. An ambiguous creation receives one list-and-detail reconciliation;
the mutation is never retried in-process. Duplicate or mismatched named rulesets
fail for deliberate inspection and are never updated or deleted automatically.
Policy calls occur only during create or reconnect setup, not during ordinary
backup, read, open, doctor, cache handling, or configured-destination
revalidation.

Creation-time verification requires GitHub to return an empty `bypass_actors`
list. GitHub may omit that field when a later reconnect has read access but not
ruleset-write access. Ballin accepts an otherwise exact active ruleset in that
case so recovery does not require administration; omission is not fresh proof
that the bypass list remains empty. An absent ruleset requires one
administration-level creation attempt after final confirmation.

Unsupported capability, denied administration, definite API rejection, or an
unconfirmed transient response fails closed: Ballin saves no destination and
prints no normal success. It does not delete a repository that was already
created and initialized. Retry/reconnect identifies that repository by its
marker and stable IDs, accepts exact protection or creates it when absent, and
avoids both replacement repositories and duplicate rulesets. This is defense in
depth against ordinary destructive ref operations. An authorized owner can
still edit or remove the ruleset or delete the repository, and a compromised
administrative account or token remains inside GitHub's authorization boundary.

## Consistency model

All selected available captures are staged before remote inspection. Collector
or projection failures abort without publication or cache promotion. Discovery
failure skips that source; exclusion gates discovery itself. Only fresh local
captures receive established empty-file/final-newline normalization. Remote and
cache bytes, including legacy `empty\n`, remain observable unchanged.

| Cached base | Remote | Local | Result |
| --- | --- | --- | --- |
| Missing | Missing | Captured | Publish addition |
| Missing | Present | Equals remote | Hydrate cache, no change for this file |
| Missing | Present | Differs | Conflict |
| Present | Missing | Any | Conflict |
| Equals remote | Present | Differs | Publish update |
| Equals remote | Present | Equals remote | No-op |
| Differs from remote | Present | Equals remote | Advance cache |
| Differs from remote | Present | Differs | Conflict |

If any snapshot conflicts, Ballin publishes nothing from that run. Snapshot
filenames are stable identities across backups. Changing which sources are
included affects future captures but does not delete existing remote snapshots
or history.

Repository caches live beneath `.backup-cache/<hash>`, using SHA-256 of the
fixed GitHub.com/owner ID/repository ID/selected branch tuple. Mutable names and
legacy cache files cannot establish a base. New linkage invalidates all
untrusted comparison state before atomically saving linkage, local consent, and
eligible restored preferences. Recovery never seeds a comparison base from remote
content. Disconnect saves both associations cleared and automatic backup disabled
before cache cleanup; retrying disconnect can finish cleanup without network access.

## Coherent repository reads and publication

A reader resolves stable identity and branch, pins its commit/tree, obtains a
complete [tree inventory](https://docs.github.com/en/rest/git/trees#get-a-tree),
and retrieves the marker and every current canonical snapshot by immutable
[blob ID](https://docs.github.com/en/rest/git/blobs#get-a-blob). Transport stdout
uses private files for large content. Tree completeness, duplicate paths, modes,
object IDs, sizes, base64 encoding, exact bytes, and Git blob hashes are checked.
Final identity/head validation must still match the inspected revision. Incomplete
results retain useful inspected facts but cannot establish absence/equality.
There is no latest-file fallback, automatic read loop, or cache write in a reader.

Authorized changes use one
[`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch)
mutation addressed by branch node ID, with `expectedHeadOid` equal to the
inspected revision. Only changed canonical additions are sent; routine backup
never sends deletions. A true no-op skips the mutation. The fixed messages are
`Initialize Ballin backup` and `Update Ballin backup`. Payloads travel through
stdin/private files, inherited API debugging is suppressed, and errors are
sanitized. GitHub controls account-based author/committer attribution; Ballin
never modifies global Git configuration.

After nominal or ambiguous publication, one independent coherent readback must
confirm the resulting commit's sole parent, complete expected inventory and
supported bytes, unchanged retained entries/marker, and stable head. A returned
commit ID must match. If the ID was lost, the same parent and exact complete
resulting state are required. Definite rejection/staleness aborts. Object creation
alone is not publication. There is no force, merge, blind retry, alternate write
transport, unreachable-object cleanup, or implicit replacement destination.

Only confirmed publication or revalidated unchanged state permits cache
promotion. Remote success followed by cache failure reports that partial result
without normal success markers. A fresh invocation reads and reconciles again;
matching local/remote content can recover without another commit. One active
writer remains the product model; retire the prior writer before a replacement
installation publishes. Conditional publication protects the inspected head,
including concurrent advancement or rewind, but does not offer multi-writer sync.

## Portable preferences

Export and restoration use separate explicit allowlists, independent of bundled
defaults. The table below records the current contract:

| Leaf | Export | Restore |
| --- | --- | --- |
| `update.cleanup` | Boolean, as described below | Boolean, subject to local precedence |
| `update.selfUpdate` | Boolean, as described below | Boolean, subject to local precedence |
| `update.softwareupdate` | Boolean, as described below | Boolean, subject to local precedence |
| `update.npm` | Boolean, as described below | Boolean, subject to local precedence |
| `update.nvm` | Boolean, as described below | Boolean, subject to local precedence |
| `analytics.enabled` | No | No; local setting |
| `update.backup` | No | No; local setup choice under #344 |
| `backup.repository`, `backup.id`, `backup.host` | No | No; independently selected destination wins |
| Sensitive-source consent | No | No; local `backup.includeSensitive` choice |
| Analytics install ID | No | No |
| Unknown/custom/future settings | No | No; existing local values remain intact |

For the five admitted update leaves, accept native JSON booleans and exact
`"true"`/`"false"` strings; export and restore canonical strings. Omit absent
export leaves without filling defaults. Invalid admitted local values or a
malformed local `update` section fail the whole projection with a key-only
diagnostic. No partial `ballin_config` is emitted, and staged successes are
discarded before remote snapshot inspection. Excluded leaves are not validated
by projection: invalid `update.backup` or an excluded `backup` section does not
block an otherwise valid export.

`analytics.enabled` is not exported or restored as a portable preference.
Remote backup data cannot change the local analytics setting or restore the
analytics install ID.

Setup captures local configuration before creating or refreshing defaults.
An admitted leaf already present is authoritative, even if default-valued or
invalid; remote data does not replace or repair it. Defaults created during
that setup invocation can be replaced by admitted remote preferences. With
neither an existing choice nor an admitted remote value, retain defaults.
Restoration changes later preferences only; it does not execute updates,
install tools, or alter integration ordering and failure handling.

The setup preflight rejects malformed local JSON, a non-object root, or present
non-object `update`, `analytics`, or `backup` sections before refresh. Missing
sections are allowed.
Malformed JSON or a non-object remote snapshot aborts reconnect; malformed remote
sections and invalid, absent, or excluded leaves are ignored independently.
An absent snapshot preserves local settings and defaults. Diagnostics do not
print rejected values or arbitrary remote content.

`update.backup` remains local-only, including when reading older snapshots.
Its maintenance-only default is `"false"`. Preserve #344's newly configured
backup prompt, existing-local-choice behavior, and post-destination save-failure
handling described in [Installation](installation.md#optional-backup-setup-and-reconnect).
Migration of a configured installation retains its local automatic-backup
choice; a replacement installation establishes its own choice during setup.

## Shared inclusion policy

Repository capture selects sources from the canonical definitions described
below. Existing configured Gists explicitly select all current sources,
including raw files and pipx. Migration and Gist runtime retirement belong to
#334.

The canonical definitions own fixed `inventory`, `sensitive`, and `preferences`
inclusion groups, separate from tool-oriented categories: 12 inventory sources,
15 sensitive sources, and one projected preferences snapshot.
`SnapshotDefinition.name` remains the durable identity and stored/read name.
The observation entrypoint accepts one native boolean, `includeSensitive`,
default false; non-boolean supplied input fails before discovery. It is an
internal argument parsed from the single local `backup.includeSensitive` setting.
Inventory and preferences form the fixed baseline. Unknown groups are excluded;
future sources/groups require an explicit inclusion and sensitivity review.

Policy-aware observation gates discovery itself. `excluded-by-policy` carries
the definition and reason, without a source or collector; collection records
a skipped result. It remains distinct from absent, unavailable, failed
discovery, and failed collection. Consumers must not stat, resolve, read, or
probe excluded sensitive sources just to verify them, including pipx executable
discovery. Exclusion does not delete existing remote/cache data or make retained
content a current capture.

`backup.includeSensitive` defaults off and accepts native booleans or exact
`"true"`/`"false"` strings. Invalid capture consent fails before discovery. Setup
uses one review/confirmation, covering raw files and pipx, and never restores
consent. Configured revalidation preserves it. Setup default refresh defers new
destination/consent leaves until the confirmed configuration transaction.
See [source review](backup-sources.md#repository-inclusion).

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

## Legacy Gist constraints

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

## Validation and downstream boundaries

`test/backup_repository.test.ts` exercises protocol and publication semantics;
`test/repository_backup.test.ts` uses a stateful fake GitHub service for public
CLI lifecycle, consent, ruleset reconciliation and failure recovery. Existing Gist
fixtures preserve the configured compatibility route. Installer walkthroughs,
doctor fixtures, and the required `npm test` use temporary roots and complete
child environments. Never manually smoke-test real user backup state.

Automated tests prove the exact policy request and Ballin's surrounding behavior;
they do not prove GitHub's live enforcement. Separately authorized disposable
real-GitHub validation must still confirm `createCommitOnBranch` fast-forward
publication and rejection of a forced ref update and branch deletion. Normal
implementation validation does not perform that experiment.
[#334](https://github.com/JBallin/ballin-scripts/issues/334) owns migration/Gist
retirement; [#336](https://github.com/JBallin/ballin-scripts/issues/336) owns
verification. The concrete repository reader/writer can be reused there without
introducing another storage model here.
