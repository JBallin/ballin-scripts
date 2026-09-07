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
other settings, but its destination fields are overridden. The restored settings
and authoritative destination are committed together; a failed commit preserves
the prior unconfigured config. An already-invalidated cache remains removed.

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
