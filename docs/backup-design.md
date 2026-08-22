# Backup design

This guide records the safety model behind `ballin backup`. User behavior and
conflict recovery are documented in
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts).

## Consistency model

- Stage every snapshot before reading or changing remote state. Collector or
  remote-read failures abort without changing the Gist or cache.
- Treat the cache as the last remote state observed by this machine. Compare
  cached, remote, and staged content—including file presence—and abort every
  conflict without mutations.
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
