# Backup design

*Maintainer guide to backup safety, GitHub storage constraints, and conflict handling.*

User behavior and conflict recovery are documented in
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts).

## Architecture and destination identity

`commands/backup_repository.ts` is a concrete storage module. It localizes GitHub
identity, trees/blobs, revisions, publication and confirmation. Commands/setup
consume canonical names, exact bytes, complete/incomplete inspection outcomes,
finite failure reasons, and a revision handle. There is no backend/provider
registry. `commands/backup.ts` owns staging, three-way comparison, and private
cache promotion for repository backups.

Local `backup.repository` is null or `{ id, ownerId, name, branch }`: opaque
GitHub node IDs establish identity, the mutable name locates REST resources,
and the initial default branch remains selected. The effective `gh api ... user`
account must be the personal GitHub.com owner. Stable-ID resolution revalidates
owner, private visibility, supported state, selected branch, and marker. A rename
cannot switch destinations. An explicit setup name must resolve to the same
identity when configured. Invalid or unsupported local destination configuration
fails without fallback or remote operations.

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

Managed-branch protection is progressive hardening, not a backup prerequisite or
part of the publication correctness contract. GitHub Free remains supported.
Ballin uses the result of the actual ruleset API operation instead of persisting
an account-plan model. The effective `gh` credential may have enough authority
for routine contents publication without having the additional repository
administration authority needed to create policy.

After bootstrap and marker/tree readback, create and reconnect setup try to
establish one repository-level branch ruleset. Explicit setup of an already
configured repository performs the same bounded revalidation. The contract is:

```json
{
  "name": "Ballin backup branch protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/<selected branch>"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

No pull-request, review, status-check, update-restriction, signed-commit, or
other collaboration policy is added. Ordinary `createCommitOnBranch`
publication remains a conditional fast-forward using `expectedHeadOid`; Ballin
does not use a bypass and never substitutes server policy for its three-way
comparison and confirmation model.

Reconciliation is read first. Ballin lists branch rulesets and considers only
the fixed Ballin name. Exactly one named policy is owned only when its repository
source, selected-branch target, active enforcement, semantic rule set, and empty
bypass list match. Matching is canonical: rule and response ordering,
case-only repository-source differences, response metadata, and harmless empty
or default representations do not trigger a rewrite. Additional policy-bearing
conditions, rules, or bypass actors are a mismatch. Because GitHub can omit
`bypass_actors` when the caller cannot write the ruleset, omission is
permission-limited/unconfirmed and is never promoted to proof of exact
protection.

When the Ballin name is absent, Ballin makes at most one creation request and
independently reads the returned resource. A mutation with an ambiguous outcome
gets one list/detail reconciliation and is never blindly repeated in the same
invocation. Duplicate or mismatched Ballin-named rulesets remain unchanged for
inspection. Unrelated rulesets and classic branch protection are never claimed,
weakened, replaced, removed, or bypassed; they can layer stricter policy on the
same branch. A future Ballin policy migration must explicitly recognize a known
prior signature rather than treating unknown mismatches as migratable.

Capability and failure classification follows the strength of GitHub's evidence.
Explicit plan/capability unavailability is `unsupported`; explicit missing
policy authority is `permission-denied`; definite validation or API rejection is
`unexpected`; malformed, transient, status-only, or otherwise incomplete
evidence is `ambiguous`. HTTP status alone does not establish unsupported
capability or missing permission, and classification does not depend on one
exact GitHub error sentence. All protection-specific outcomes are nonfatal to an
otherwise valid setup. Unsupported capability is silent; newly enabled policy
gets one concise confirmation; permission, unexpected, and unresolved ambiguous
results get setup-only notes or warnings without claiming protection.

These semantics do not weaken repository identity, initialization, coherent
read, transport-cleanup, or local-persistence failures. Protection state is not
stored in config or cache, and ordinary backup, read, open, doctor, recovery,
and cache handling make no policy calls. Ballin does not retarget or delete stale
policy when a branch changes. The ruleset is defense in depth against accidental
branch deletion and non-fast-forward history rewrite; it does not block ordinary
external fast-forward updates or a sufficiently authorized administrator from
altering policy or deleting the repository.

## Self-update maintenance

Self-update validates the configured destination's account and ownership, private
repository requirements, selected branch, complete inventory and format marker,
then rechecks the effective account and revision. It updates the saved destination
if the repository was renamed. It performs the same managed-protection
reconciliation described above. Invalid settings and maintenance failures remain
visible.

This inspection returns destination and revision metadata without snapshot bytes;
it cannot supply a full comparison or publication read. Snapshot-content read or
integrity failures alone do not fail standalone self-update. Installer refresh,
explicit backup setup, doctor, backup, publication readback and the readiness
check following embedded self-update use full reads. That readiness check can
fail after self-update succeeds. Doctor is read-only and makes no policy calls.

## Consistency model

All selected available captures are staged before remote inspection. Collector
or projection failures abort without publication or cache promotion. Discovery
failure for a selected Codex or Claude Code source aborts before staging; other
discovery failures skip that source. Exclusion gates discovery itself. Only fresh local
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

A full reader resolves stable identity and branch, pins its commit/tree, obtains a
complete [tree inventory](https://docs.github.com/en/rest/git/trees#get-a-tree),
and retrieves the marker and every current canonical snapshot by immutable
[blob ID](https://docs.github.com/en/rest/git/blobs#get-a-blob). Transport stdout
uses private files for large content. Tree completeness, duplicate paths, modes,
object IDs, sizes, base64 encoding, exact bytes, and Git blob hashes are checked.
Final identity/head validation must still match the inspected revision. Incomplete
results retain useful inspected facts but cannot establish absence/equality.
There is no latest-file fallback, automatic read loop, or cache write in a reader.

`backup read <snapshot>` uses the same identity, complete inventory, marker and
final revision validation, but fetches only the requested supported snapshot's
content. `backup list` and `backup open` fetch only marker content. List presents
current canonical selectors actually present, distinguishes retired names,
omits reserved metadata, and counts unexpected entries without disclosing their
names. Retired and unexpected content require deliberate inspection through
`backup open`, which prints the validated destination URL before opening it.
These commands use immutable blob IDs and the same content validation.
Unrequested snapshot contents are not validated. Inventory-only inspection still
requires the complete tree, marker and final revision checks; it cannot infer
absence from a partial result. Callers receive only inventory entries, snapshot
bytes with their inventory, or a URL, never a partial comparison/publication base.
Bare `backup read` and unmatched selectors show actual saved options using the
same list formatter. An unmatched read reuses its complete inspected inventory
without another remote lookup; failures retain their stage-specific diagnostics.
Backup, publication readback, readiness and reconnect keep full reads.

Saved discovery does not observe local sources, invoke collectors, change capture
policy, or promote caches/status. It reports presence, not provenance, freshness,
content readability or verification. A valid marker-only backup lists no current
snapshots successfully; missing or invalid identity/marker remains an error.
Listing adds no inspection-specific analytics; the existing coarse top-level
command event and opt-outs apply without backup-specific data.

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
matching local/remote content can recover without another commit.

After cache promotion and private temporary-file cleanup succeed, a changed
backup prints the confirmed commit's GitHub URL using the validated repository
owner and name. No extra remote lookup or persisted revision pointer is needed.
Unchanged or failed runs print no commit link, and Ballin does not open a browser.
One active writer remains the product model; retire the prior writer before a
replacement installation publishes. Conditional publication protects the inspected head,
including concurrent advancement or rewind, but does not offer multi-writer sync.

## Local last-success time

Normal repository backup records one canonical UTC time after publication or
no-op confirmation, required comparison-cache work and temporary cleanup complete.
Timestamp eligibility follows normal writer success, including runs that skip
sources after discovery failure.

Store the owner-only local file in the existing cache namespace keyed by stable
owner/repository identity and selected branch, excluding mutable name and current
revision. Rename and later remote changes preserve the record; disconnect/new
linkage invalidates it through existing cache-root lifecycle handling.

Replacement is atomic and advisory: failure preserves the prior valid time and
does not fail, roll back or republish completed data work. Status is excluded from
required snapshot-cache permission repair. Reads never repair or create state and
reject missing, malformed, insecure or future times. The record is never exported
through `ballin_config`, written to GitHub or sent in analytics; it is not a receipt, current-state
verification or freshness policy. See [Last successful backup](backup-sources.md#last-successful-backup)
for display behavior.

## Portable preferences

Export and restoration use separate explicit allowlists, independent of bundled
defaults. The table below records the current contract:

| Setting or state | Export | Restore |
| --- | --- | --- |
| `update.cleanup` | Saved if present | Recovered only if absent before setup |
| `update.selfUpdate` | Saved if present | Recovered only if absent before setup |
| `update.softwareupdate` | Saved if present | Recovered only if absent before setup |
| `update.npm` | Saved if present | Recovered only if absent before setup |
| `update.nvm` | Saved if present | Recovered only if absent before setup |
| `analytics.enabled` | No | No; local analytics choice |
| `update.backup` | No | No; local automatic-backup choice |
| Backup destination | No | No; independently selected during setup |
| `backup.includeSensitive` | No | No; local sensitive-source choice |
| Analytics install ID | No | No; local installation identity |
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
Its maintenance-only default is `"false"`. New linkage prompts for the choice;
configured-destination revalidation preserves it. See
[Installation](installation.md#optional-backup-setup-and-reconnect) for setup and
post-destination save-failure handling.
A replacement installation establishes its own automatic-backup choice during
setup.

## Shared inclusion policy

Repository capture selects sources from the canonical definitions described
below.

The canonical definitions own fixed `inventory`, `sensitive`, and `preferences`
inclusion groups, separate from tool-oriented categories: 12 inventory sources,
29 sensitive sources, and one projected preferences snapshot.
`backup.includeSensitive` is the only local sensitive-source preference. Opting
in covers the maintained sensitive catalog, including future supported sources;
existing opt-ins therefore include Codex and Claude Code. Setup discloses this
scope before acceptance and reviews the currently available source paths. Consent is never
projected or recovered. Configured destination revalidation preserves the
existing choice. Adding supported sources requires user-facing disclosure and
an inclusion/sensitivity review, without another approval record.

Global Codex `AGENTS.md` and `AGENTS.override.md` are independent durable
sources: both are captured when present, regardless of instruction precedence.
Shared personal skills at fixed `HOME/.agents/skills` use `codex_user_skills.bundle.json`,
independently of `CODEX_HOME`; legacy `CODEX_HOME/skills` remains
`codex_skills.bundle.json`. Both omit root `.system` and retain distinct snapshot
identities, even when `CODEX_HOME=HOME/.agents` selects the same directory. Both staged archives count
toward the combined byte budget, with separate per-source entry limits.

Codex file capture is intact, including embedded trust settings in main/profile
TOML, with existing final-newline/empty-file normalization. It does not execute
or restore configuration. Recursive authoring directories use the shared
`ballin-directory` JSON format, version 2: sorted relative regular-file entries
with an `executable` boolean and explicit `encoding`. UTF-8 text uses a `content`
array containing one physical line per element, including its original LF/CRLF
terminator. Empty text uses an empty array; a final unterminated line remains
unterminated. BOMs and Unicode bytes are preserved without normalization. Invalid
UTF-8 and content with non-text controls use Base64 string content. No timestamps,
absolute paths or empty directories are stored. Source-specific generated exclusions and
symlink rejection are documented in [source sensitivity](backup-sources.md#codex-configuration).

### Bundle inspection

`backup read <snapshot> --list` returns member metadata as JSON, with control and
directional formatting characters escaped for display. `--file <path>` emits the
exact decoded bytes of one member to stdout without framing or newline changes.
Both use the existing saved-snapshot reader, including destination, inventory,
marker, account and revision validation. The entire bundle archive is checked
before any member output: version-2 schema, relative paths, unique
names, boolean executable flags, valid text lines or canonical Base64 regular-file
content. Unsupported versions, link records and malformed entries fail without disclosing payloads in
diagnostics. Inspection accepts at most 16 MiB of stored archive bytes and 8,192
members. These checks occur after transport and do not bound remote downloads.

Raw reads return stored bytes unchanged. Inspection accepts version 2 only;
older versions require manual decoding outside Ballin. Member paths never reach
filesystem operations, and decoded content is never executed or restored.

Bundle snapshots use `.bundle.json` names. Plain snapshots retain their existing
names. Old bundle names are retired without read aliases and are retained if
present; they can coexist with new bundle filenames. The flat repository layout
and backup marker version remain unchanged. Bundle listings supply an inspection
hint; raw and file-list hints appear only when stdin, stdout and stderr are
terminals. Raw hints require a known bundle name and a validated archive.

Reconciliation uses exact stored bytes and the ordinary conflict rules. No
format-conversion exception or semantic JSON normalization applies. Old-name
caches cannot establish a comparison base for new filenames.

### Capture bounds and traversal

New Codex and Claude Code captures are each bounded to 16 MiB total normalized
staged bytes per application (raw files and all archives, including unchanged
captures) and 8,192 visited entries per
recursive source. Incremental iterative metadata traversal and opened-file
bounded reads reject overflow without truncation. Text capture incrementally
preflights escaped line sizes and JSON indentation before allocating content lines; binary capture
checks Base64 size before encoding. The serialized-byte budget includes line-array
and escape overhead, so raw source bytes alone do not determine whether a capture fits.
Capture-limit failures abort staging before remote inspection; cache comparison
and writer checks also fail before publication or cache promotion. Actual changed buffers are rechecked before
outer base64 allocation. Its wire allowance is derived from the stored-byte cap,
not a second 16 MiB cap. Only Codex and Claude Code cache files actually compared
are bounded, individually, to 16 MiB. The independent capture allowances permit up to 32 MiB
of combined staged assistant configuration; adding Claude Code does not reduce
the existing Codex allowance. Other sources retain their existing behavior.

There is no retained-remote quota or partial-reader contract. Existing full
remote inspection, retained snapshots, and mixed-source payloads can exceed
the local capture envelope; this is not a global request or process-memory
guarantee. New canonical names may recognize previously unexpected large remote
blobs. Remote-reader resource bounds remain separate follow-up work.

Codex and Claude Code traversal and reads use a private synchronous cwd-pinning
helper. Each directory identity is captured from its pinned parent and verified after entry;
callbacks use only the pinned directory or immediate names. Leaf opens reject
symlinks; review opens and closes regular files to check readability without
reading contents. Caller cwd identity is verified after restoration. Restoration
failure is fatal and bypasses optional-source handling. These checks pin selected
directory objects; they do not provide an atomic snapshot of concurrent edits.

Claude Code definitions select `CLAUDE.md` and only regular `.md` files in
personal rules, agents, and legacy commands. The catalog supplies the Markdown
selection to discovery, review, and capture. Visited-entry accounting precedes
filename filtering. Selected hard links fail without searching for other inode
locations, and opened-file checks enforce the same rule during capture. Skills
remain excluded pending a separate operational eligibility/supporting-file
policy; path placement alone does not establish authorship.

The current updater compares the Git blob identities of the source-definition
file before and after a successful update. Changed or unavailable comparison
emits a stateless source-guide advisory. It never executes definitions or
discovers personal sources; advisory failure does not turn a successful update
into failure.
Setup and the source guide disclose the catalog independently of that advisory.

`SnapshotDefinition.name` remains the durable identity and stored/read name.
The observation entrypoint accepts a native boolean, `includeSensitive`,
default false; non-boolean supplied input fails before discovery.
Inventory and preferences form the fixed baseline; unknown groups are excluded.

Policy-aware observation gates discovery itself. `excluded-by-policy` carries
the definition and reason, without a source or collector; collection records
a skipped result. It remains distinct from absent, unavailable, failed
discovery, and failed collection. Consumers must not stat, resolve, read, or
probe excluded sensitive sources just to verify them, including pipx executable
discovery. Exclusion does not delete existing remote/cache data or make retained
content a current capture.

`backup.includeSensitive` defaults off and accepts native booleans or exact
`"true"`/`"false"` strings. Invalid capture consent fails before discovery. Setup
uses one review/confirmation for sensitive sources. Setup default refresh defers new
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

## Validation and downstream boundaries

`test/backup_repository.test.ts` exercises protocol and publication semantics;
`test/repository_backup.test.ts` uses a stateful fake GitHub service for public
CLI lifecycle, consent, ruleset reconciliation and failure recovery. Installer
walkthroughs, doctor fixtures, and the required `npm test` use temporary roots and complete
child environments. Never manually smoke-test real user backup state.

Automated tests prove the exact policy request and Ballin's surrounding behavior;
they do not prove GitHub's live enforcement. Separately authorized disposable
real-GitHub validation must still confirm `createCommitOnBranch` fast-forward
publication and rejection of a forced ref update and branch deletion. Normal
implementation validation does not perform that experiment.

Identity, coherent-read, and publication checks do not certify that saved
snapshots match current sources after subsequent changes.

## Historical repository latency measurements

These measurements record specific historical revisions, not current runtime
guarantees. They explain the read/open optimization while the safety contracts
above remain authoritative.

### macOS real-GitHub measurements

Measured on 2026-10-01 on an Apple M5 (arm64), macOS 27.0.1, Node 24.21.0
and GitHub CLI 2.102.0. The baseline is main commit
`91fdfc989c8325f387bc898752d0920c79b58e4d`, including the deterministic
uninstall coverage fix. Candidate read, backup and reconnect measurements used
`454e929f8664d46f76be178b2c64f6f03daa3091`; final open measurements used
`0a016c4f5d07761ffcab42c2437a700713bf21f2`. The latter changes only open
dispatch, leaving the other measured production paths identical.

Both arms ran the real `bin/ballin` CLI against the approved private dummy
repository `JBallin/ballin-perf-367-macos-20261001`, with the same credential,
network, marker, README and three small supported snapshots (`ballin_config`,
`mas`, `npm_global`). Each arm had its own temporary HOME, configuration,
cache and source files. Analytics was disabled. Collectors used dummy command
outputs, and `GH_BROWSER` recorded the dispatched URL instead of opening a
browser. Only `gh` subprocesses used the normal credential-storage context;
Ballin's local state stayed isolated. No user backup data was read or published.

Each comparison scenario has ten runs per arm, paired with alternating arm
order and an equal number of baseline-first and candidate-first pairs. Read, no-op,
publishing and reconnect were measured in two passes of five pairs. Open was
remeasured in ten pairs after its browser-dispatch optimization. The table
shows whole-CLI medians and observed ranges in seconds; external head checks
and publishing warm-ups are outside the measured interval.

| Command/scenario | Baseline median (range) | Candidate median (range) |
| --- | ---: | ---: |
| `backup read mas` | 3.690 (3.285–4.150) | 2.770 (2.712–3.038) |
| `backup open` | 4.751 (4.444–5.589) | 3.203 (2.692–4.217) |
| Repeated true no-op `backup` | 4.694 (4.429–5.674) | 4.648 (4.554–5.024) |
| Changed/publishing `backup` | 9.921 (9.025–10.464) | 9.545 (8.796–10.968) |
| Reconnect through first candidate validation | 4.590 (4.302–5.175) | 4.896 (4.219–5.863) |

Read improves by 0.920 seconds (24.9%) at the median; open improves by
1.548 seconds (32.6%). The unchanged backup and reconnect paths have overlapping
ranges; their median differences do not establish an optimization speedup.

Read returned the exact dummy `mas` bytes. Open printed and dispatched the
validated fixture URL. Every no-op, read, open and reconnect run left the remote
head unchanged. Each measured publishing run started from a warmed comparison
base, changed one dummy snapshot, and produced exactly one commit whose sole
parent was the inspected head; Ballin completed its independent full readback.
The dummy repository remains retained; deleting it requires separate authorization.

### Costs and retained checks

Timing each synchronous subprocess attributes about 96–98% of read, backup
and reconnect wall time to `gh`. This combines CLI startup, credential access
and GitHub transport; it does not isolate network time. Seven standalone
`gh --version` samples averaged 0.033 seconds, while local residual time in
the measured commands was roughly 0.10–0.13 seconds. Dummy collector
subprocesses took about 0.06 seconds per backup; real tool inventories and
browser UI startup are outside this fixture's results.

Candidate cumulative subprocess medians, in seconds:

| Scenario | Account | Repository/branch metadata | Tree | Blobs | Other remote work |
| --- | ---: | ---: | ---: | ---: | --- |
| Read | 0.613 | 1.057 | 0.339 | 0.661 | — |
| Open | 1.037 | 1.195 | 0.401 | 0.373 | Browser dispatch 0.050 |
| No-op | 0.901 | 1.778 | 0.350 | 1.397 | — |
| Publishing | 1.583 | 2.959 | 0.728 | 2.724 | Mutation 1.251 |
| Reconnect | 0.961 | 1.305 | 0.368 | 1.487 | Candidate lookup 0.421 |

Category medians need not sum to whole-command medians. Metadata and serial
blob requests dominate the shared inspection. Publishing subprocess phases
had medians of 4.455 seconds before mutation, 1.251 for mutation and 3.460
for independent readback. A no-op still fully reads and reconciles its current
state, then validates the account and head before promoting the cache; it
creates no blobs, trees, commits or ref updates. Publishing retains the
expected-head mutation and independent full readback. These measured costs
do not justify removing required evidence or introducing a broader transport
or caching redesign.

The reconnect pause after `Candidate backup:` measured 4.174 seconds at the
baseline median (3.858–4.691) and 4.434 in the candidate (3.765–5.387). It
contains the candidate lookup and the same full inspection primitives. Runs
cancelled before destination confirmation, excluding human waiting, the second
full inspection, configuration persistence and optional protection work.

The create-side pause was measured separately on production commit
`8a4df04dbdd93cc4c6c83d800661c55d67007235`, with the same macOS/Node/gh
versions. Ten real `backup setup` runs selected `create` with dummy name
`ballin-perf-367-create-absent-20261001-8a4df04`. Authenticated GitHub GETs
returned 404 before and after every run. Each run used a fresh temporary HOME,
configuration and cache location, with analytics disabled. Input ended at the
sensitive-source prompt, before destination confirmation; configuration bytes
remained unchanged, no cache was created and no remote resource was created.
A measurement guard allowed only account and candidate GETs.

From `Candidate backup:` to the following inventory/sensitivity explanation,
the create-side pause had a median of 0.290 seconds (0.239–0.341). Its only
subprocess was the candidate repository GET returning 404: median 0.289 seconds,
about 99.5% of the pause. Effective-account resolution ran before the candidate
line and took 0.291 seconds (0.251–0.309). Whole CLI time through cancellation
was 0.706 seconds (0.647–0.747), including a 0.042-second config subprocess.
These timings combine process, credential and GitHub transport costs.

Create selection therefore shares account resolution and the candidate lookup,
but does not perform reconnect's full metadata/tree/blob inspection before
confirmation. Reconnect's measured pause contains ten API calls; create's
contains one. Setup was unchanged by the measured optimization, so these
observations characterize the two paths without attributing a setup speedup to
that change. Actual
post-confirmation repository creation/initialization, later setup validation,
configuration persistence and optional protection work remain outside the
measured pauses. No further production optimization is justified by this
single required existence lookup.

With three snapshots, read drops from 9 to 7 API calls, retrieving only the
marker and requested supported snapshot. Open drops from 11 to 8 `gh` calls,
retrieving only the marker. Both still validate the complete tree inventory,
stable repository/owner identity, immutable requested blobs, marker and final
revision. Partial reads stay private to the transport module and cannot become
reconciliation or publication bases. Fresh effective-account checks through
`gh api user` remain, including final validation and URL generation; compatibility
does not depend on `gh auth status --active` or aggregate saved-account status.

Open dispatches its validated URL with `gh browse --repo`, using GitHub CLI's
browser facility without `gh repo view --web`'s extra repository metadata
lookup. Five alternating dispatch-only pairs confirmed the identical URL and
median 0.505 → 0.055 seconds. This removes redundant dispatch work after Ballin's
validation. Full no-op (11 API calls),
publishing (21) and reconnect selection/first validation (11) are unchanged.
