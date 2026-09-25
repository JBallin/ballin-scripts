# Analytics

**Audience:** Users

Analytics help show which top-level Ballin commands are used, how real backups
finish, and whether automatic backup and Ballin self-update steps succeed
during `ballin update`.

Analytics start disabled. During a fresh installation, Ballin asks whether to
enable minimal anonymous usage analytics, with Yes as the default. Submitting
blank input or `y` enables analytics; `n` or closing input leaves them disabled.
The choice is saved only in the local Ballin config. Installation and answering
the question send no analytics event. Refreshes and self-updates preserve an
existing local choice without asking again.

The single `analytics.enabled` setting controls both command and behavioral
analytics. Missing, disabled, or malformed analytics configuration suppresses
both. Backups do not save or restore the setting or install ID; older backed-up
analytics settings are ignored too.

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

CI never sends analytics. `BALLIN_NO_ANALYTICS=1` suppresses both kinds of event.
`BALLIN_NO_COMMAND_ANALYTICS=1` suppresses only command events; Ballin uses it
internally to avoid counting automatic backup and self-update as separate
top-level commands. It does not suppress eligible behavioral events.

Delivery is best-effort. Ballin gives pending sends a bounded time to finish
before normal process exit, with no persistent queue or delivery retries.
Analytics failures do not interrupt commands or later update steps, change
output or exit status, or hide an operation's original failure.

## What Is Sent

### Command events

The existing schema-v1 command payload contains:

- `schemaVersion`: `1`
- `installId`: random installation UUID
- `dateBucket`: UTC date, in `YYYY-MM-DD` form
- `command`: top-level command name, such as `ballin update` or `ballin backup`
- `status`: `success`, `failure`, or `unknown`
- `durationBucket`: `unknown`, `<1s`, `1-10s`, `10-60s`, `1-10m`, or `10m+`
- `appVersion`: released `ballin-scripts` version
- `nodeMajor`: Node.js major version
- `osVersion`: coarse macOS product version, such as `26.6`, or `unknown`

`ballin update` sends one top-level command event. Its internally invoked
backup and self-update do not send additional command events. Direct
`ballin doctor` and `ballin self-update` retain their ordinary command events.

### Behavioral events

Behavioral events describe the final result of these operations:

| Event | What it observes |
| --- | --- |
| `backup.run` | A valid real-backup request, including failure during configuration, authentication, or cache preflight. One result covers the complete operation, regardless of its caller. |
| `update.backup` | The result of the automatic backup child invoked by `ballin update`. |
| `update.self-update` | The result of the automatic Ballin self-update child, before the separate readiness check. |

A completed backup with no changes counts as success. Required collection,
reconciliation, publication, or cache failure makes the backup fail, including
cache failure after a successful remote write. Internal retries produce one
final result, with no per-source or per-snapshot events.

For automatic update steps, child exit zero means success, including self-update
with no newer version available. Launch failure, a nonzero exit, or observed
signal termination means failure. A later readiness failure can fail the overall
update while `update.self-update` remains successful. Disabled, skipped, or
unreached steps send no event.

Setup, read, open, disconnect, help, invalid arguments, and other paths that do
not execute a real backup send no behavioral event. Direct doctor and self-update
send no behavioral event either.

The schema-v2 payload contains exactly these five fields:

```json
{
  "schemaVersion": 2,
  "installId": "826f9faa-9995-4f66-a01b-73b4f7aebdf1",
  "dateBucket": "2026-09-19",
  "event": "backup.run",
  "status": "success"
}
```

Only the three event names above and `success` / `failure` are allowed.
`dateBucket` is the UTC date of the terminal outcome, not a precise timestamp.
Behavioral sends require an existing valid install ID and do not create one.
They contain no command name, duration, app/runtime/OS version, caller, backup
status details, or other dimensions.

An automatic backup can send both child `backup.run` and parent `update.backup`;
these intentionally answer different questions. They cannot be matched or
combined into exact backup or adoption statistics. See the maintainer guide's
[interpretation limits](analytics-backend.md#interpreting-behavioral-outcomes).

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
- source or snapshot names, retry counts, or individual API-call details
- invocation identifiers

## Storage

The random install ID lives locally under `.analytics/`. Ballin's hosted
analytics service uses it to limit incoming requests. For command events, the
service retains server-hashed install/day activity and separate command and
runtime counts.

Behavioral storage contains only UTC date, event name, terminal status, and
count. Neither raw nor hashed installation identity is retained with these
outcomes, and they do not add to command, runtime, or observed-install counts.
They cannot establish unique-install adoption, first/repeat backup, feature
retention, or user percentages.

The service deletes all analytics rows older than 395 days. Application analytics
do not store IP addresses; request source metadata is used transiently for rate
limiting. Cloudflare may process request metadata for its own operation.
Public events can be spoofed, and participation and delivery are incomplete, so
counts are directional maintenance signals.
