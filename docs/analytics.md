# Analytics

Analytics start disabled. During a fresh installation, Ballin asks whether to
enable minimal anonymous usage analytics:

```text
Enable minimal anonymous usage analytics? [Y/n]
```

Press Enter or answer `y` to enable analytics, or answer `n` to keep them
disabled. If input reaches end-of-file before a response is submitted, analytics
remain disabled. The selected setting is saved only in the local Ballin config.
Neither installation nor answering the analytics prompt sends an analytics event.

Enable persistently:

```shell
ballin config set analytics.enabled true
```

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
command output, side effects, or exit status. Refresh and self-update do not
prompt and preserve an existing valid local analytics choice. Temporary
environment suppression does not rewrite that persisted choice.

The analytics setting and installation identity are not saved in or restored
from `ballin_config`. Analytics sections in older snapshots are ignored without
changing the local setting. Guided reconfiguration is tracked separately in
[#352](https://github.com/JBallin/ballin-scripts/issues/352). The exact
portability rules are recorded in [Backup design](backup-design.md#portable-preferences).

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

Ballin creates a random local install ID under `.analytics/` only after
`analytics.enabled` is saved as `true` and when the environment allows analytics.
ID creation is silent and non-blocking. The backend hashes
install IDs before storage, stores daily install rows plus
aggregate command/application-version/Node/macOS-version counts, and deletes
rows older than 395 days.

Events are sent only when analytics are enabled and the CLI is configured with
the production analytics endpoint. The endpoint accepts public client telemetry,
so valid events can be spoofed; aggregate analytics are directional and not
security-trustworthy.

For deployment details, see [Analytics backend](analytics-backend.md).
