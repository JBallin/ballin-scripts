# Analytics Worker

This is the backend for Ballin's minimal command and behavioral analytics.
It is intentionally isolated from the CLI so the command package does not gain
runtime analytics SDK dependencies.

The backend is a Cloudflare Worker with a D1 database binding. It accepts
versioned, strictly allowlisted payloads and stores daily aggregates for observed
install activity, command usage, and terminal behavioral outcomes. Schema-v1
ingestion stores the HMAC-derived installation ID only in the separate
`install_days` activity table. The `command_events_daily` and
`version_events_daily` aggregates retain no installation identity or
install-to-command association. Schema-v2/v3 behavioral ingestion retains neither
raw nor hashed installation identity.

## Data Policy

The worker may store:

- daily bucket, in `YYYY-MM-DD` format
- HMAC-derived installation ID in `install_days` only, from schema-v1 ingestion
- command name from a fixed allowlist
- behavioral event name: `backup.run`, `update.backup`, or `update.self-update`
- status from a fixed allowlist
- backup failure category from a fixed allowlist
- duration bucket from a fixed allowlist
- released Ballin version, Node.js major version, and coarse macOS product
  version
- aggregate counts

The worker must not store:

- raw install IDs
- IP addresses
- command arguments
- usernames
- local paths
- backup destination IDs or URLs
- dotfile contents
- package lists
- editor settings or extension lists
- raw errors, stdout, or stderr
- environment variables
- arbitrary config values

## Endpoint

`POST /v1/events`

Schema-v1 command payload (unchanged):

```json
{
  "schemaVersion": 1,
  "installId": "826f9faa-9995-4f66-a01b-73b4f7aebdf1",
  "dateBucket": "2026-06-27",
  "command": "ballin update",
  "status": "success",
  "durationBucket": "10-60s",
  "appVersion": "2.0.0",
  "nodeMajor": "24",
  "osVersion": "26.6"
}
```

Schema-v2 behavioral payload:

```json
{
  "schemaVersion": 2,
  "installId": "826f9faa-9995-4f66-a01b-73b4f7aebdf1",
  "dateBucket": "2026-06-27",
  "event": "backup.run",
  "status": "success"
}
```

V2 accepts exactly these five fields. `event` is one of `backup.run`,
`update.backup`, and `update.self-update`; `status` is `success` or `failure`.
The date is the UTC terminal-outcome bucket. No command, duration, runtime,
caller, or other dimensions are accepted.

The installation ID is used transiently to derive the existing HMAC rate-limit
key. V2 ingestion increments only
`behavior_events_daily(date_bucket, event, status, count)`, keyed by date/event/status.
It retains no raw or hashed identity and writes nothing to install-day, command,
or runtime aggregates. Schema v1 continues to populate those existing tables.

Schema-v3 backup outcome payload extends v2 only for `backup.run`:

```json
{
  "schemaVersion": 3,
  "installId": "826f9faa-9995-4f66-a01b-73b4f7aebdf1",
  "dateBucket": "2026-06-27",
  "event": "backup.run",
  "status": "failure",
  "failureCategory": "transport"
}
```

V3 failures require exactly one allowlisted `failureCategory`: `transport`,
`authentication`, `reconciliation`, `local_state`, or `unknown`. V3 successes
omit that field. Other fields and parent event names are rejected. V1 and v2
remain accepted unchanged. A v3 failure increments its existing behavioral total
and `backup_failures_daily(date_bucket, category, count)` in one atomic batch.
Success increments only the existing total. Category storage retains no identity.

Responses:

- `204` when the event is accepted
- `400` for invalid JSON or invalid event fields
- `429` when rate limits are exceeded
- `404` for unknown paths
- `405` for unsupported methods

All schemas require:

- `installId` is a lowercase UUID
- `dateBucket` is today, yesterday, or tomorrow in UTC
- the JSON body is 2048 bytes or smaller
- the JSON body contains no fields outside its documented schema

Schema v1 additionally requires:

- `command` is one of the currently instrumented Ballin commands, including
  `ballin`, `ballin update`, `ballin backup`, `ballin config`,
  `ballin doctor`, `ballin self-update`, `ballin setup`, and `ballin uninstall`
- `appVersion` is a released numeric version such as `1.0.0`
- `nodeMajor` is a numeric major version
- `osVersion` is a coarse macOS product version such as `26.6`, or `unknown`
- `status` is `success`, `failure`, or `unknown`
- `durationBucket` accepts `unknown`, `<1s`, `1-10s`, `10-60s`, `1-10m`, or
  `10m+`; v1 retains its fallback to `unknown` for absent, empty, or non-string
  duration values

The Worker uses request source metadata only for transient rate limiting and
does not retain it in analytics. Cloudflare may process metadata operationally
before the Worker runs.

The endpoint accepts public client telemetry. Valid events can be spoofed, so
aggregate analytics are directional and not security-trustworthy. The Worker
limits abuse with strict schema validation, low-cardinality fields, body-size and
date-skew checks, server-side install ID hashing, and Cloudflare Workers rate
limits. All schemas share the global, source, and installation rate-limit keys.
Source admission runs first through `ANALYTICS_SOURCE_RATE_LIMITER`, configured
for 1,000 requests per minute in its own namespace. Only admitted requests charge
the global key through `ANALYTICS_RATE_LIMITER`; global and installation limits
remain 1,500 per minute. Missing either limiter or the hash secret fails closed.
These values are a best-effort policy, not calibrated production capacity or a
guaranteed reservation for another source. Cloudflare counters apply per location
and may be permissive; clients sharing an IP also share the source allowance
across installations and all schemas. Additional events may be dropped without
affecting CLI outcomes. See the [Cloudflare rate-limit binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Request source
metadata is used only as a transient rate-limit key and is
not stored, queried, logged, or reported by the application. Older clients may
still send `X-Ballin-Analytics-Token`; the Worker ignores that legacy header.

## Production Setup

Run these commands from `analytics-worker/`. Install the locked maintenance
and deployment tool first:

```shell
npm ci --include=dev
```

The package scripts use the installed local Wrangler. Use `npm run wrangler --`
followed by Wrangler arguments for other maintenance commands.

1. Copy `wrangler.toml.example` to the ignored local deployment config:

   ```shell
   cp wrangler.toml.example wrangler.toml
   ```

2. Create a D1 database:

   ```shell
   npm run wrangler -- d1 create ballin-scripts-analytics
   ```

3. Fill in the database ID in `wrangler.toml`. Preserve both limiter bindings:
   namespace `1001` for global/installation limits and distinct namespace `1002`
   for the lower source limit. Existing local configs need the new source binding
   before deploying this Worker; it does not fall back to the global limiter.
4. Set the hash secret:

   ```shell
   npm run wrangler -- secret put INSTALL_ID_HASH_SECRET
   ```

5. Apply migrations:

   ```shell
   npm run migrate:remote
   ```

6. Create the `analytics-worker-production` GitHub deployment environment, allow
   deployments only from `main`, and add these environment secrets:

   - `CLOUDFLARE_API_TOKEN`, from a Cloudflare Account API Token created with
     the `Edit Cloudflare Workers` template
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_D1_DATABASE_ID`

7. Confirm the `Deploy Analytics Worker` GitHub Actions workflow completes
   after Worker or deployment input changes land on `main`.

## Automatic Deploys

Pull-request CI owns full repository validation. The deploy workflow runs
automatically after pushes to `main` that change the deploy workflow, `.nvmrc`,
or anything under `analytics-worker/` except its `README.md`. README-only edits
do not deploy; edits that also change a deployment input still do. The Worker
directory remains a conservative ownership boundary so new Worker-local
deployment inputs are not missed.

The workflow pins its GitHub Actions to full commit SHAs and installs Wrangler
with `npm ci` from this directory's lockfile. Deployment and verification use
that local executable.

Before an automatic deployment, the workflow stops if migrations must be
applied manually. It then creates an ignored runner-local `wrangler.toml` from
`wrangler.toml.example`, and requires `CLOUDFLARE_D1_DATABASE_ID` before running
`npm run deploy` from this directory. It then runs `npm run verify:deployment`
to inspect every Worker version receiving production traffic and fails unless
each version exposes
`ANALYTICS_DB` as a D1 binding,
`ANALYTICS_RATE_LIMITER` and `ANALYTICS_SOURCE_RATE_LIMITER` as rate-limit bindings, and
`INSTALL_ID_HASH_SECRET` as a secret-text binding. The check uses structured
Wrangler deployment and version metadata; it does not parse deploy output or
make unrelated Wrangler warnings fatal.

The workflow does not set or rotate `INSTALL_ID_HASH_SECRET`. Cloudflare exposes
the secret binding name and type without exposing its value, so deployment
verification can confirm that the secret is attached but cannot confirm that
its value is correct. Binding metadata likewise does not prove D1 schema or
migration state, database reachability, limiter namespaces or budgets, or runtime
rate-limit behavior. Inspect the configuration to confirm separate namespaces
and the 1,000/1,500 limits before an authorized deployment.

Keep the Cloudflare values as environment secrets rather than repository
secrets. The workflow can also be run manually from GitHub Actions, but
production deploys are guarded by the `analytics-worker-production` environment
and a `main` ref check.

Remote D1 migrations remain manual. An automatic deploy stops when
`analytics-worker/migrations/` changed since the last successful deploy. From
`analytics-worker/`, apply the remote migration, then rerun the workflow manually
from `main`.

```shell
npm run migrate:remote
```

### Behavioral Analytics Rollout

Installed clients update directly from `main`. The recorded
[backend-first rollout](../docs/analytics-backend.md#behavioral-analytics-rollout)
requires separate backend and client releases: land compatible ingestion, apply
the additive migration with production authorization, manually deploy from
`main`, and verify schema and ingestion readiness before landing client sends.

This records the release sequence; code on `main` does not establish production
migration or deployment readiness.

The new migration preserves existing data. Do not reset or backfill aggregates
for behavioral analytics. Deployment binding checks alone cannot establish that
the migration is applied or that all serving Worker versions accept v2.

### Backup Category Compatibility

Schema-v3 ingestion and the category report/reset require additive migration
`0004`. Apply that migration before compatible backend deployment and verify all
serving versions' schema, v1/v2/v3 ingestion, and atomic counting before releasing
client v3 sends. See [category compatibility requirements](../docs/analytics-backend.md#category-compatibility-requirements).
Binding checks alone do not establish readiness. Preserve existing counts without
category backfill or reset. Migration and deployment require separate production
authorization.

### Historical OS-Family Removal Cutover

This earlier destructive cutover does not apply to the behavioral migration.

The migration that removes OS family recreates `version_events_daily` without
copying its historical rows. If completing this historical cutover after the
change is on `main`:

1. Apply pending remote D1 migrations with the command above.
2. Rerun the `Deploy Analytics Worker` workflow.
3. From the repository root, establish a clean baseline with
   `npm --prefix analytics-worker run reset -- --confirm RESET_ANALYTICS_AGGREGATES`.
4. Confirm a current schema-v1 event is accepted and run `npm run
   analytics:report` to verify the fresh aggregate shape.

The old Worker cannot write to the recreated table, so ingestion may fail
between steps 1 and 2. Analytics are best-effort and cannot affect Ballin
command behavior.

Manual deploys remain available for emergency or local maintenance. Run these
commands from `analytics-worker/`:

```shell
npm run deploy
npm run verify:deployment
```

The production endpoint is:

```text
https://ballin-scripts-analytics.jballin.workers.dev/v1/events
```

## Retention

The scheduled worker deletes daily rows older than 395 days. That keeps roughly
13 months of daily data, enough for DAU/WAU/MAU trends without keeping an
indefinite install history.

## Queries

Example D1 queries for the key maintenance questions live in `queries/`.

## Reporting

Run the read-only production report from the repository root:

```shell
npm run analytics:report
```

By default, the report covers the last 30 UTC days ending today. To choose an
inclusive date range:

```shell
npm run analytics:report -- --from 2026-06-01 --to 2026-06-30
```

The report uses local Wrangler authentication and
`analytics-worker/wrangler.toml` to run remote D1 `SELECT` queries. It prints:

- active installs by day
- top-level command usage
- command success, failure, and unknown counts
- application, Node.js, and macOS-version trends from existing aggregate rows
- behavioral outcomes by event: total, successes, failures, and failure rate
- backup-only failure categories, legacy uncategorized failures, and coverage

Behavioral totals include terminal outcomes only; `total = successes + failures`
and `failure_rate = failures / total`. The query examples also support daily
grouping. See [interpretation limits](../docs/analytics-backend.md#interpreting-behavioral-outcomes):
automatic backup events intentionally overlap, and independent delivery loss,
interruptions, mixed versions, and UTC date boundaries prevent matching events.
They cannot establish exact direct-backup volume, execution coverage, unique-install
adoption, feature retention, or user percentages.

The default output keeps the shared telemetry caveat above the tables, the
parent/child overlap warning beside behavioral outcomes, and the legacy/unknown
distinction beside category coverage. Extended interpretation lives in the
[behavioral guide](../docs/analytics-backend.md#interpreting-behavioral-outcomes)
and [category guide](../docs/analytics-backend.md#backup-failure-categories).
Observed opt-in, best-effort public telemetry is incomplete and directional,
not security-trustworthy; it does not establish root causes or population
adoption/failure rates.

For empty ranges, active-install dates remain zero-filled and the other sections
report no observed events or failures. Category coverage prints `0/0 (0.0%)`;
this means no observed backup failures, not measured zero population risk.
The caveats and interpretation reference remain visible.

On a machine where this repository has not been configured for Worker access,
create the ignored local config first:

```shell
cp analytics-worker/wrangler.toml.example analytics-worker/wrangler.toml
```

Then fill in the D1 `database_id` and make sure Wrangler is authenticated for
the Cloudflare account. Install the locked tool from the repository root, then
authenticate locally:

```shell
npm ci --prefix analytics-worker --include=dev
npm --prefix analytics-worker run wrangler -- login
```

The database ID is not a secret by itself; remote reads are still controlled by
Wrangler auth.

The report does not read or print Cloudflare secrets. Do not paste secret
values into the report command. Reporting requires the installed local Wrangler
and prints an installation command if it is missing.

Reporting reads these aggregate tables:

- `install_days`
- `command_events_daily`
- `version_events_daily`
- `behavior_events_daily`
- `backup_failures_daily`

It does not expose installation-linked behavioral history, command
arguments, local paths, backup destination details, package/editor data, raw errors,
environment variables, arbitrary config values, IP storage, or raw install IDs.

## Resetting Aggregates

The Worker reset script clears the aggregate analytics tables when an
operator wants a fresh reporting baseline. It is a rare maintenance utility,
not a normal project workflow. The first expected use is the Ballin 2 CLI
rename, where a clean canonical-command baseline is more useful than mixing
historical `up` / `gu` rows with `ballin <command>` rows.

The reset clears all aggregate analytics tables:

- `install_days`
- `command_events_daily`
- `version_events_daily`
- `behavior_events_daily`
- `backup_failures_daily`

There is no raw event table.

From the repository root, preview the current production row counts before
deleting anything:

```shell
npm --prefix analytics-worker run reset -- --dry-run
```

Reset the production aggregates only after confirming that historical aggregate
data is no longer needed:

```shell
npm --prefix analytics-worker run reset -- --confirm RESET_ANALYTICS_AGGREGATES
```

Verify the fresh reporting baseline:

```shell
npm run analytics:report
```

The reset command uses local Wrangler authentication and the ignored
`analytics-worker/wrangler.toml` file, like the report command. Run
`npm --prefix analytics-worker run wrangler -- login` from the repository root
first if local Wrangler authentication is not configured. Reset requires the
same installed local Wrangler as reporting.
