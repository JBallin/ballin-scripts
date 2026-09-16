# Analytics

**Audience:** Users

Analytics help show which top-level Ballin commands are used and whether they
succeed or fail.

Analytics start disabled. During a fresh installation, Ballin asks whether to
enable minimal anonymous usage analytics, with Yes as the default. The choice
is saved only in the local Ballin config. Answering the question does not send
an analytics event.

Disable persistently:

```shell
ballin config set analytics.enabled false
```

Use `true` instead of `false` to enable analytics persistently.

Disable analytics for one command:

```shell
BALLIN_NO_ANALYTICS=1 ballin update
```

Disable for a shell session or profile:

```shell
export BALLIN_NO_ANALYTICS=1
```

CI never sends analytics. Analytics failures are ignored; they do not interrupt
commands or change their output or exit status.

Backups do not save or restore the analytics setting or install ID.

## What Is Sent

- schema version
- random install ID
- date bucket, such as `YYYY-MM-DD`
- command name, such as `ballin`, `ballin update`, and `ballin backup`
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

The random install ID lives locally under `.analytics/`. When analytics are
sent, Ballin's hosted analytics service processes them and stores server-hashed
install IDs and aggregate analytics data. The service deletes data older than
395 days.
