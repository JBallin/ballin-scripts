# Analytics

`ballin-scripts` can send minimal anonymous usage analytics after the installer
shows a first-run notice. Analytics show active installs, top-level command
usage, and command success or failure.

Disable persistently:

```shell
ballin config set analytics.enabled false
```

Disable for one command:

```shell
BALLIN_NO_ANALYTICS=1 ballin update
```

Replace `ballin update` with the command you are running.

Disable for a shell session or profile:

```shell
export BALLIN_NO_ANALYTICS=1
```

CI never sends analytics. Analytics failures are ignored and never change
command output, side effects, or exit status.

## What Is Sent

- schema version
- random install ID
- date bucket, such as `YYYY-MM-DD`
- command name for currently instrumented top-level commands, such as `ballin`,
  `ballin update`, and `ballin backup`
- status: `success`, `failure`, or `unknown`
- coarse duration bucket: `unknown`, `<1s`, `1-10s`, `10-60s`, `1-10m`, or
  `10m+`
- `ballin-scripts` version
- Node.js major version
- OS family: `darwin`, `linux`, `win32`, or `unknown`
- coarse OS version

## What Is Never Sent

- command arguments
- usernames
- local paths
- Gist IDs or URLs
- dotfile contents
- package lists
- editor settings or extensions
- raw errors or command output
- environment variables
- config values

## Storage

The installer creates a random local install ID under `.analytics/`. The
backend hashes install IDs before storage, stores daily install rows plus
aggregate command/version/Node/OS counts, and deletes rows older than 395 days.

Events are sent only when analytics are enabled and the CLI is configured with
the production analytics endpoint and public client token.

For deployment details, see [Analytics backend](analytics-backend.md).
