# Analytics Backend

`ballin-scripts` uses a small Cloudflare Worker backed by D1 for usage
analytics. The backend records only the minimal signals needed for active
installs, top-level command usage, and command success or failure.

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
daily install and command-count data.

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
active installs, top-level command usage, command success/failure counts, and
runtime/version trends. It does not require, accept, or print Cloudflare secret
values.

Analytics ingestion is public client telemetry. Valid events can be spoofed, so
reports are directional maintenance signals rather than security-trustworthy
counts.

The report only reads the existing aggregate tables: `install_days`,
`command_events_daily`, and `version_events_daily`. It does not introduce new
telemetry fields or report feature-level events, command arguments, local paths,
Gist details, package/editor data, raw errors, environment variables,
arbitrary config values, IPs, or raw install IDs.

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

## Abuse Controls

The Worker accepts public client events and relies on layered abuse controls
instead of a client-shipped secret. It rejects oversized payloads and unsupported
fields, validates dates and low-cardinality runtime values, hashes install IDs
before storage, applies global/source rate limits before parsing, and applies an
install-hash rate limit before D1 writes. Request source metadata is used only as
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
- apply `analytics-worker/migrations/0001_initial.sql` with `--remote`
- confirm the `Deploy Analytics Worker` workflow completed after the relevant
  change landed on `main`
- confirm the deployed Worker returns `204` for a valid event, `400` for
  unsupported fields or invalid enums, and `429` when rate limits are exceeded
- query D1 to confirm only hashed install/day rows and aggregate counts are
  stored

Deploy failures are visible in GitHub Actions. Remote D1 migrations remain
manual and should use `--remote`; migration changes stop publishing until the
remote migration is applied and the deploy workflow succeeds from `main`.
