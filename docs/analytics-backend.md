# Analytics Backend

**Audience:** Maintainers

Ballin uses a small Cloudflare Worker backed by D1 for usage
analytics. The backend records only the minimal signals needed for active
installs, top-level command usage, and terminal backup and automatic-update
outcomes. Command and behavioral aggregates remain separate.

The backend lives in [`analytics-worker/`](../analytics-worker/). Its package
README covers Worker setup and maintenance commands.

## Production Setup

Production sends use the deployed workers.dev endpoint:

```text
https://ballin-scripts-analytics.jballin.workers.dev/v1/events
```

The Worker has a D1 binding, scheduled retention cleanup, an
`INSTALL_ID_HASH_SECRET`, and an `ANALYTICS_RATE_LIMITER` binding for
`POST /v1/events`.
Worker-impacting changes deploy from `main` through the `Deploy Analytics
Worker` GitHub Actions workflow.

## Why Cloudflare Worker and D1

- The event schema is owned by this project and can reject anything outside the
  privacy allowlist.
- D1 can count active installs from daily buckets and server-hashed install IDs.
- The CLI does not need a runtime analytics SDK.
- Retention is controlled by the Worker and D1 schema.
- The deployment can stay tiny: one Worker, one D1 database, one rate-limit
  binding, and one hash secret.

## Alternatives Considered

- PostHog has good dashboards and capture APIs, but it is a broader analytics
  stack than the current maintenance question needs.
- Plausible is privacy-focused, but its visitor model is shaped around web
  traffic headers rather than CLI install IDs.
- Workers Analytics Engine is useful for high-cardinality metric streams, but D1
  is simpler for exact low-volume usage counts.

## Retention

The Worker deletes rows older than 395 days. That keeps roughly 13 months of
daily install, command, runtime, and behavioral-outcome data.

## Reporting

Use the local read-only report for production D1 aggregates:

```shell
npm run analytics:report
```

To report on a specific inclusive UTC date range:

```shell
npm run analytics:report -- --from 2026-06-01 --to 2026-06-30
```

The report runs Wrangler D1 `SELECT` queries against the remote database using
local Wrangler authentication and the ignored local
`analytics-worker/wrangler.toml` described in the Worker README. It shows daily
active installs, top-level command usage, command success/failure counts,
application/Node/macOS-version trends, and a separate behavioral-outcomes
section. It does not require, accept, or print Cloudflare secret values.

Run `npx wrangler login` first if local Wrangler authentication is not
configured. The report tries a directly available `wrangler` command first. If
that command is unavailable, it falls back to `npx --yes wrangler`, which allows
npx to install Wrangler without prompting.

Analytics ingestion is public client telemetry. Valid events can be spoofed, so
reports are directional maintenance signals rather than security-trustworthy
counts.

The report reads `install_days`, `command_events_daily`,
`version_events_daily`, and `behavior_events_daily`. Behavioral rows contain
only UTC date, event name, terminal status, and count. They contain no raw or
hashed installation identity and do not contribute to observed-install activity
or runtime trends.

### Interpreting Behavioral Outcomes

Each event has its own total, successes, failures, and failure rate
(`failures / total`). Only terminal outcomes are counted:

- `backup.run`: real backup operations across callers, including successful
  no-ops and preflight failures. Required collection, reconciliation,
  publication, or cache failure makes the whole operation fail.
- `update.backup`: the automatic backup child's invocation result.
- `update.self-update`: the automatic Ballin self-update child's invocation
  result, before the separate readiness check. Readiness can fail overall
  update while this event remains successful.

Automatic backup can produce both `backup.run` and `update.backup`. Do not sum
them into total backups, subtract them to infer exact direct-backup volume, or
divide by command counts to claim exact update-stage coverage. Launch failure
can produce a parent failure without a child backup event. Independent delivery
loss, interruption, mixed client versions, and adjacent UTC date buckets prevent
matching observations.

These counts do not establish unique-install adoption, first/repeat backup,
feature retention, or user percentages. Existing observed-install activity stays
separate. Participation is selective, delivery is best-effort, and public events
are spoofable; rate limits do not authenticate installations or outcomes.
Product value and reasons for behavior still require separate research.

The query examples include per-event totals and daily grouping. Neither the
queries nor report expose command arguments, paths, destination details,
package/editor data, raw errors, environment variables, configuration values,
IPs, or raw install IDs.

## Resetting Aggregates

Use `analytics-worker/reset.ts` when production analytics should start from a
fresh reporting baseline. It is a rare maintenance utility, not a normal
project workflow. The first expected use is the Ballin 2 canonical CLI rename,
where the chosen cleanup path is a clean reset instead of mapping old `up` /
`gu` rows into reports.

The reset scope is the full aggregate schema:

- `install_days`
- `command_events_daily`
- `version_events_daily`
- `behavior_events_daily`

There is no raw event table to preserve or delete.

Preview production row counts:

```shell
node analytics-worker/reset.ts --dry-run
```

Clear production aggregate rows:

```shell
node analytics-worker/reset.ts --confirm RESET_ANALYTICS_AGGREGATES
```

Confirm the fresh reporting baseline after reset:

```shell
npm run analytics:report
```

The reset utility uses the same local Wrangler authentication and fallback
behavior as the report.

## Abuse Controls

The Worker accepts public client events and relies on layered abuse controls
instead of a client-shipped secret. It rejects oversized payloads and unsupported
fields, validates dates and low-cardinality values, applies global/source rate
limits before parsing, and applies an installation-HMAC rate limit before D1
writes. Both schemas share those rate-limit budgets. Only command events retain
the installation hash in `install_days`; behavioral ingestion uses it transiently
for rate limiting. Request source metadata is used only as
a transient Cloudflare rate-limit key; it is not stored, queried, logged, or
reported by the application.

## Production Checklist

For production setup or recreation:

- create the D1 database
- copy `analytics-worker/wrangler.toml.example` to ignored local
  `analytics-worker/wrangler.toml`
- set the D1 database ID in local `analytics-worker/wrangler.toml`
- set `INSTALL_ID_HASH_SECRET`
- create the `analytics-worker-production` GitHub deployment environment with a
  `main` branch rule and environment secrets `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID`
- apply all pending D1 migrations with `wrangler d1 migrations apply
  ballin-scripts-analytics --remote`
- confirm the `Deploy Analytics Worker` workflow completed after the relevant
  change landed on `main`; after deploying, the workflow verifies every Worker
  version receiving traffic has the required D1, rate-limit, and hash-secret
  binding names and types
- confirm the deployed Worker returns `204` for a valid event, `400` for
  unsupported fields or invalid enums, and `429` when rate limits are exceeded
- query D1 to confirm only hashed install/day rows and aggregate counts are
  stored

Deploy failures are visible in GitHub Actions. Remote D1 migrations remain
manual and should use `--remote`; migration changes stop publishing until the
remote migration is applied and the deploy workflow succeeds from `main`.
The deployment check verifies Cloudflare binding metadata without exposing
secret values. It cannot verify the hash secret's value, D1 schema or migration
state, resource reachability, or runtime rate-limit behavior.

## Behavioral Analytics Rollout

The additive behavioral migration and compatible ingestion must reach production
before client sends are released. Installation and self-update consume `main`,
so backend and client changes must land separately:

1. Land the deployment-boundary fix in [#402](https://github.com/JBallin/ballin-scripts/pull/402)
   and verify its production workflow succeeds.
2. Land the backend change containing the new table and v1/v2 ingestion. Its
   automatic deployment should stop at the existing manual-migration guard.
3. With production authorization, apply the new migration, then manually run
   `Deploy Analytics Worker` from `main`.
4. Verify migration completion and that all Worker versions receiving traffic
   run compatible ingestion. Binding verification alone does not establish
   schema readiness or v2 support.
5. Only then land the client change that sends behavioral events.

The migration preserves existing aggregates, and compatible ingestion continues
to accept current v1 command payloads. Do not backfill behavioral outcomes from
command counts or reset data for this rollout. Production migration, deployment,
reset, and live ingestion verification require separate authorization.

## Historical OS-Family Removal Cutover

This procedure applies only to the earlier OS-family migration, not the additive
behavioral migration above.

The migration that removes the redundant OS-family dimension intentionally
recreates `version_events_daily` without preserving its historical rows. After
the change lands on `main`, perform the cutover in this order:

1. Apply pending D1 migrations with `wrangler d1 migrations apply
   ballin-scripts-analytics --remote`.
2. Rerun the `Deploy Analytics Worker` workflow so the Worker and revised table
   schema become compatible.
3. Run `node analytics-worker/reset.ts --confirm
   RESET_ANALYTICS_AGGREGATES` to establish a clean baseline across every
   aggregate table.
4. Confirm a current schema-v1 event is accepted and use `npm run
   analytics:report` to verify the fresh aggregate shape.

Ingestion can fail between the migration and Worker deployment. Analytics are
best-effort, and this cutover does not affect Ballin command behavior.
