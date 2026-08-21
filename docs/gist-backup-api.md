# Gist backup API evidence

This note records the transport assumptions behind Ballin's staged
single-request backup. The sources were reviewed on August 21, 2026, with
GitHub CLI 2.98.0 installed locally. The verification used official
documentation and isolated command fixtures; it did not create or modify a
live Gist.

## Update request behavior

GitHub's [Update a gist REST endpoint](https://docs.github.com/en/rest/gists/gists#update-a-gist)
accepts one `files` object in `PATCH /gists/{gist_id}`. The object can contain
multiple filename keys. The endpoint explicitly says files omitted from an
edit remain unchanged, so Ballin includes only snapshots that the three-way
comparison classifies as safe local changes.

Each included filename maps to an object with `content`. The endpoint's
schema also documents that a `null` file value, or an object without
`content` or `filename`, deletes that file. Ballin never emits those forms.
An empty collected snapshot is normalized to the literal text `empty\n` and
sent as ordinary content. GitHub CLI's documented
[`gh gist edit --add`](https://cli.github.com/manual/gh_gist_edit) behavior and
its [2.98.0 implementation](https://github.com/cli/cli/blob/v2.98.0/pkg/cmd/gist/edit/edit.go)
also model an added filename as a content-bearing file entry in a Gist update.

The isolated backup fixture verifies that new and existing files can share
one changed-only payload, omitted files remain untouched, and no deletion
entries are generated.

## GitHub CLI transport and hosts

The [`gh api` manual](https://cli.github.com/manual/gh_api) documents:

- `--hostname` for selecting the GitHub host;
- `--method` for selecting `PATCH`; and
- `--input` for sending a pre-built request body from a file.

Ballin therefore invokes one command equivalent to:

```shell
gh api --hostname <host> --method PATCH gists/<id> --input <payload> --silent
```

The configured hostname is passed explicitly, including for GitHub
Enterprise hosts. The complete JSON document is written before the command is
started, and a logical backup is never divided across requests.

The [GitHub CLI exit-code reference](https://cli.github.com/manual/gh_help_exit-codes)
defines zero as success and nonzero results for failure, cancellation, or
authentication requirements. A nonzero exit, process error, or signal does
not prove that a mutating request was rejected before GitHub received it.
Ballin consequently treats interrupted outcomes as potentially ambiguous,
leaves all cache entries unchanged, and re-reads remote state on the next run.

## Complete remote reads

GitHub's [Gist truncation documentation](https://docs.github.com/en/rest/gists/gists#about-gists)
says the REST response includes at most 1 MiB of content per file and marks a
larger result with `truncated: true`. Full content is available through the
file's `raw_url`; files larger than 10 MiB may require cloning the Gist.

Ballin reads small snapshots from the Gist metadata response. For a truncated
file it uses `gh gist view --raw --filename`, whose
[2.98.0 implementation](https://github.com/cli/cli/blob/v2.98.0/pkg/cmd/gist/view/view.go)
follows `raw_url` when `truncated` is true. Ballin also checks the retrieved
byte count against the metadata size. A failed, interrupted, or incomplete
read is not treated as an absent file and prevents every remote and cache
mutation. This preserves the existing support for snapshots larger than
1 MiB.

If the top-level Gist file list is itself marked truncated, Ballin fails
closed because a missing filename cannot be distinguished from an omitted
metadata entry.

## Guarantees and limits

The Update a gist endpoint documents a multi-file request and a successful
`200` response. It does not document transactional atomicity. Ballin therefore
uses the term **staged single-request backup**, not atomic backup.

GitHub's [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
state that conditional requests for unsafe methods such as `PATCH` are not
supported unless a specific endpoint says otherwise. The Gist update endpoint
does not document an exception or a precondition parameter. Ballin detects
divergence observed during its read, but another writer can still change the
Gist between that read and the PATCH.

No applicable request-body maximum is documented by the Gist endpoint, the
`gh api` manual, or GitHub's
[REST troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
reviewed for this change. This is not a claim that every GitHub or Enterprise
deployment accepts an unlimited payload. Ballin does not invent a universal
limit: it sends one request, reports a host rejection, and leaves caches
unchanged. Host-specific limits can therefore fail the run without causing
Ballin to split it.

These boundaries require one active writer per backup Gist. The staged flow
does not provide synchronization, merging, machine profiles, or elimination
of the read/write race.
