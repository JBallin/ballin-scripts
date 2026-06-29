# Analytics

`ballin-scripts` can send minimal anonymous usage analytics after the installer
shows a first-run notice. Analytics help show whether anyone is using the app,
which top-level commands they use, and whether those commands succeed or fail.

Disable persistently:

```shell
ballin_config set analytics.enabled false
```

Disable for one command:

```shell
BALLIN_NO_ANALYTICS=1 up
```

Replace `up` with the command you are running.

CI never sends analytics. Analytics failures are ignored and never change
command output, side effects, or exit status.

## What Is Sent

- schema version
- random install ID
- date bucket, such as `YYYY-MM-DD`
- command name for currently instrumented top-level commands: `up`, `gu`,
  `ballin_update`, and `ballin`
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
an analytics endpoint and token.

For deployment details, see [Analytics backend](analytics-backend.md).
