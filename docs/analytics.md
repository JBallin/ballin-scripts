# Analytics

Analytics start disabled. During a fresh installation, Ballin asks whether to
enable minimal anonymous usage analytics, with Yes as the default. Pressing
Enter accepts Yes; end-of-file without a submitted response leaves analytics
disabled. The choice is saved only in the local Ballin config. Neither
installation nor answering the question sends an analytics event.

Enable persistently:

```shell
ballin config set analytics.enabled true
```

Use `false` instead of `true` to disable analytics persistently.

Disable analytics for one `ballin update` run:

```shell
BALLIN_NO_ANALYTICS=1 ballin update
```

Disable for a shell session or profile:

```shell
export BALLIN_NO_ANALYTICS=1
```

CI never sends analytics. Analytics failures are ignored; they do not interrupt
commands or change their output or exit status. Refresh and self-update do not
ask again and preserve the saved setting. Temporary environment suppression
does not rewrite it.

The analytics setting and installation identity remain local. Neither is
included in backup snapshots or preference recovery.

## What Is Sent

- schema version
- random install ID
- date bucket, such as `YYYY-MM-DD`
- command name for currently instrumented Ballin commands, such as `ballin`,
  `ballin update`, and `ballin backup`
- status: `success`, `failure`, or `unknown`
- coarse duration bucket: `unknown`, `<1s`, `1-10s`, `10-60s`, `1-10m`, or
  `10m+`
- `ballin-scripts` version
- Node.js major version
- coarse macOS product version as major/minor when available, such as `26.6`,
  or `unknown` when unavailable

## What Is Never Sent

- command arguments
- usernames
- local paths
- backup destination IDs or URLs
- dotfile contents
- package lists
- editor settings or extensions
- raw errors or command output
- environment variables
- config values

## Storage

Ballin maintains a random local install ID under `.analytics/` when analytics
are enabled and not suppressed by `BALLIN_NO_ANALYTICS` or CI. Creating or
repairing the ID is silent and non-blocking. The backend hashes install IDs
before storage, stores daily install rows plus aggregate
command/application-version/Node/macOS-version counts, and deletes rows older
than 395 days.

Events are sent only when analytics are enabled and the CLI is configured with
the production analytics endpoint.
