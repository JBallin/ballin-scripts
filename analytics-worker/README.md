# Analytics Worker

This is the backend for the minimal `ballin-scripts` active-install analytics.
It is intentionally isolated from the CLI so the command package does not gain
runtime analytics SDK dependencies.

The backend is a Cloudflare Worker with a D1 database binding. It accepts a
single narrow event shape, hashes the client install ID before storage, and
stores only daily aggregates needed for DAU/WAU/MAU, command counts, and failure
counts.

## Data Policy

The worker may store:

- daily bucket, in `YYYY-MM-DD` format
- server-hashed install ID
- command name from a fixed allowlist
- status from a fixed allowlist
- duration bucket from a fixed allowlist
- coarse version/runtime fields from a fixed allowlist
- aggregate counts

The worker must not store:

- raw install IDs
- IP addresses
- command arguments
- usernames
- local paths
- Gist IDs or URLs
- dotfile contents
- package lists
- editor settings or extension lists
- raw errors, stdout, or stderr
- environment variables
- arbitrary config values

## Endpoint

`POST /v1/events`

Required header:

```text
X-Ballin-Analytics-Token: <configured ingest token>
```

Example payload:

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
  "os": "darwin",
  "osVersion": "15"
}
```

Responses:

- `204` when the event is accepted
- `400` for invalid JSON or invalid event fields
- `401` when the ingest token is missing or invalid
- `404` for unknown paths
- `405` for unsupported methods

The event is rejected unless:

- `installId` is a lowercase UUID
- `dateBucket` is today, yesterday, or tomorrow in UTC
- `command` is one of the currently instrumented Ballin commands, including
  `ballin`, `ballin update`, `ballin backup`, `ballin config`,
  `ballin doctor`, `ballin self-update`, and `ballin uninstall`
- `appVersion` is a released numeric version such as `1.0.0`
- the JSON body is 2048 bytes or smaller
- the JSON body contains no fields outside the documented schema

The worker should ignore request IP for analytics purposes. Cloudflare may still
process request metadata operationally before the worker runs; the application
schema does not read or persist it.

The ingest token is a public client gate once it is shipped in the CLI, not a
secret abuse solution for a distributed CLI. The Worker also uses a Cloudflare
Workers rate limiting binding for `POST /v1/events`.

## Production Setup

Run these commands from `analytics-worker/`. If Wrangler is not installed
globally, use `npx wrangler` in place of `wrangler`.

1. Copy `wrangler.toml.example` to the ignored local deployment config:

   ```shell
   cp wrangler.toml.example wrangler.toml
   ```

2. Create a D1 database:

   ```shell
   wrangler d1 create ballin-scripts-analytics
   ```

3. Fill in the database ID in `wrangler.toml`.
4. Set the hash secret:

   ```shell
   wrangler secret put INSTALL_ID_HASH_SECRET
   ```

5. Set the ingest token:

   ```shell
   wrangler secret put INGEST_TOKEN
   ```

6. Apply migrations:

   ```shell
   wrangler d1 migrations apply ballin-scripts-analytics --remote
   ```

7. Create the `analytics-worker-production` GitHub deployment environment, allow
   deployments only from `main`, and add these environment secrets:

   - `CLOUDFLARE_API_TOKEN`, from a Cloudflare Account API Token created with
     the `Edit Cloudflare Workers` template
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_D1_DATABASE_ID`

8. Confirm the `Deploy Analytics Worker` GitHub Actions workflow completes
   after Worker-impacting changes land on `main`.

## Automatic Deploys

The deploy workflow runs `npm test`, creates an ignored runner-local
`wrangler.toml` from `wrangler.toml.example`, fills in the D1 database ID from
`CLOUDFLARE_D1_DATABASE_ID`, and runs `wrangler deploy` from this directory. It
does not set or rotate the existing Cloudflare Worker secrets
`INSTALL_ID_HASH_SECRET` or `INGEST_TOKEN`.

Keep the Cloudflare values as environment secrets rather than repository
secrets. The workflow runs automatically on Worker-impacting pushes to `main`
and can also be run manually from GitHub Actions, but production deploys are
guarded by the `analytics-worker-production` environment and a `main` ref check.

Remote D1 migrations remain manual. The deploy workflow stops before deploying
when `analytics-worker/migrations/` changed since the last successful deploy;
after applying the remote migration, rerun the workflow manually from `main`.

```shell
wrangler d1 migrations apply ballin-scripts-analytics --remote
```

Manual deploys remain available for emergency or local maintenance:

```shell
wrangler deploy
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
- runtime/version trends from existing aggregate rows

On a machine where this repository has not been configured for Worker access,
create the ignored local config first:

```shell
cp analytics-worker/wrangler.toml.example analytics-worker/wrangler.toml
```

Then fill in the D1 `database_id` and make sure Wrangler is authenticated for
the Cloudflare account. The database ID is not a secret by itself; remote reads
are still controlled by Wrangler auth.

The report does not read or print Cloudflare secrets. Do not paste secret
values into the report command. If Wrangler is not installed globally, the
script falls back to `npx wrangler`.

Reporting stays within the existing aggregate schema:

- `install_days`
- `command_events_daily`
- `version_events_daily`

It does not add telemetry fields or expose feature-level events, command
arguments, local paths, Gist details, package/editor data, raw errors,
environment variables, arbitrary config values, IP storage, or raw install IDs.
