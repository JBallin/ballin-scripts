# Backup design

This maintainer guide records the consistency invariants and GitHub transport
assumptions behind `ballin backup`. User behavior and conflict recovery are
documented in
[Supported capabilities](capabilities.md#backup-consistency-and-conflicts).

## Run invariants

- Collect and normalize every available snapshot before reading the Gist or
  changing remote or cache state. Continue after collector failures, then abort
  without mutations if any collector failed.
- Read current remote state after staging. A missing file is a valid state; a
  failed, interrupted, truncated, or incomplete read fails the run.
- Treat each cache file as the last remote content observed by this machine.
  Compare cached base, current remote, and staged local content, including file
  presence. Any conflict aborts the complete run without mutations.
- Send safely changed files in at most one PATCH. Omit unchanged files and
  never send null or deletion entries; empty snapshots remain `empty\n`.
- Promote caches with staged per-file replacement only after the remote outcome
  is known. Failed or uncertain requests leave caches unchanged for a fresh
  remote read on retry. Report promotion failures without success markers.

The presence-aware decision cases are covered as an executable table in
[`test/backup.test.ts`](../test/backup.test.ts).

## GitHub transport evidence

Verified August 21, 2026 against official documentation and GitHub CLI 2.98.0.

| Assumption | Evidence | Design consequence |
| --- | --- | --- |
| One update can carry multiple files. Omitted files remain unchanged, while null or contentless entries delete files. | GitHub REST: [Update a gist](https://docs.github.com/en/rest/gists/gists#update-a-gist) | Send one `files` object containing only changed `{ "content": ... }` entries. |
| Large Gist files may return truncated inline content with a `raw_url`; the documented `size` is in bytes. | GitHub REST: [About gists](https://docs.github.com/en/rest/gists/gists#about-gists) | Fetch raw content when required and validate byte length, preserving snapshots larger than 1 MiB. Treat incomplete reads as failures. |
| `gh api` accepts a host, explicit method, and complete input body. | GitHub CLI: [`gh api`](https://cli.github.com/manual/gh_api) | Route reads and writes through the configured GitHub or Enterprise hostname and submit one payload. |
| The CLI reports generic success or failure exit status, not a server-side transaction outcome. | GitHub CLI: [Exit codes](https://cli.github.com/manual/gh_help_exit-codes) | Conservatively treat nonzero or interrupted update calls as uncertain outcomes and do not promote caches. |

The Gist update documentation does not define a transactional multi-file update
or conditional PATCH precondition. GitHub's general
[conditional request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
does not add one to this endpoint. Ballin therefore retains a read/write race
and supports one active writer per backup Gist; it does not synchronize, merge,
or automatically resolve changes from multiple machines.

The update endpoint, `gh api` reference, and GitHub's
[REST troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
do not document an applicable universal request-payload maximum. Ballin does
not invent one or split a logical backup. A host rejection fails the single
request and leaves caches unchanged.
