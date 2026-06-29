# Analytics Backend

`ballin-scripts` uses a small Cloudflare Worker backed by D1 for usage
analytics. The goal is to see whether anyone is using the app and how, not to
run a general product analytics platform.

The backend skeleton lives in [`analytics-worker/`](../analytics-worker/). It is
not deployed by default and does not require a Cloudflare account to work on the
CLI.

## Production Setup

Production sends stay disabled until the CLI endpoint and token are configured.
Before enabling them, confirm deployment, D1 binding, migrations, secrets,
retention cleanup, abuse controls, and payload alignment with the first-run
notice and [Analytics](analytics.md).

## Why Cloudflare Worker and D1

- The event schema is owned by this project and can reject anything outside the
  privacy allowlist.
- D1 can count active installs from daily buckets and server-hashed install IDs.
- The CLI does not need a runtime analytics SDK.
- Retention is controlled by the Worker and D1 schema.
- The deployment can stay tiny: one Worker, one D1 database, and two secrets.

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

## Abuse Controls

The skeleton requires an ingest token before accepting events and rejects
oversized payloads. A distributed CLI cannot keep a token truly secret, so this
is a deployment gate rather than the complete production abuse story. Before
real production traffic is enabled, configure Cloudflare-side rate limiting or
equivalent edge protection for `POST /v1/events`.

## Production Checklist

Before enabling the CLI to send production events:

- create the Cloudflare Worker project
- create the D1 database
- apply `analytics-worker/migrations/0001_initial.sql`
- set `INSTALL_ID_HASH_SECRET`
- set `INGEST_TOKEN`
- configure Cloudflare-side rate limiting or equivalent edge protection
- deploy the Worker
- configure the CLI endpoint in the client implementation
- re-check that the client payload, first-run notice, and `docs/analytics.md`
  match the documented allowlist
