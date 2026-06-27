# Analytics Worker

This is the proposed backend for the minimal `ballin-scripts` active-install
analytics described in issue #166. It is intentionally isolated from the CLI so
the command package does not gain runtime analytics SDK dependencies.

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
  "command": "up",
  "status": "success",
  "durationBucket": "10-60s",
  "appVersion": "1.0.0",
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
- `appVersion` is a released numeric version such as `1.0.0`
- the JSON body is 2048 bytes or smaller

The worker should ignore request IP for analytics purposes. Cloudflare may still
process request metadata operationally before the worker runs; the application
schema does not read or persist it.

The ingest token is a deployment gate for the backend skeleton, not a permanent
abuse solution for a distributed CLI. Before production traffic is enabled,
configure Cloudflare-side rate limiting or equivalent edge protection for
`POST /v1/events`.

## Local Setup

This repository does not require a live Cloudflare project yet. When ready:

1. Copy `wrangler.toml.example` to `wrangler.toml`.
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

6. Configure Cloudflare-side rate limiting for `POST /v1/events`.
7. Apply migrations:

   ```shell
   wrangler d1 migrations apply ballin-scripts-analytics
   ```

8. Deploy:

   ```shell
   wrangler deploy
   ```

## Retention

The scheduled worker deletes daily rows older than 395 days. That keeps roughly
13 months of daily data, enough for DAU/WAU/MAU trends without keeping an
indefinite install history.

## Queries

Example D1 queries for the key maintenance questions live in `queries/`.
