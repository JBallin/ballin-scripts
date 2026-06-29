# Optional capabilities

This guide covers choices for the required Node.js setup, plus optional tools
and settings that extend `ballin-scripts`. The defaults keep updates predictable
while letting you opt in to broader automation.

## Node.js

Node.js is required by `ballin-scripts`; install it using whichever method fits
your environment. For development, we recommend [nvm](https://github.com/nvm-sh/nvm)
with the latest Node.js long-term support (LTS) release. It supports switching
versions, project-specific `.nvmrc` files, and a user-local installation.

Follow nvm's official
[installation and shell setup instructions](https://github.com/nvm-sh/nvm#installing-and-updating),
then install Node.js LTS:

```shell
nvm install --lts
```

Installed commands use the `node` found on your shell `PATH`, so make sure new
terminal sessions use a supported Node.js version too.

After installing `ballin-scripts`, optionally let `up` install newer LTS
releases:

```shell
ballin_config set up.nvm true
```

`up.nvm` runs `nvm install --lts`; it does not update nvm itself. It defaults to
`false` because enabling it opts into newer LTS releases, and installing a new
Node.js version does not migrate your globally installed npm packages
automatically. If nvm cannot be loaded, `up` warns and continues with its
remaining updates.

For a simpler setup, install Homebrew's current Node.js release instead:

```shell
brew install node
```

With this option, Homebrew manages Node.js updates along with your other formulae.
The `up.nvm` setting does not apply.

## Mac App Store apps

Install [`mas`](https://github.com/mas-cli/mas) with Homebrew to add Mac App
Store support:

```shell
brew install mas
```

When `mas` is available, `up` updates installed App Store apps and `gu` includes
the installed-app list in your backup. No configuration setting is required.

## Gist backups

`gu` uses [GitHub CLI](https://cli.github.com/) to read and update the
configured backup Gist. During install, `ballin-scripts` prompts for the GitHub
host, including GitHub Enterprise hosts, checks `gh` authentication for that
host, and either adopts an existing backup Gist or creates a new one. When an
adopted backup includes saved `ballin_config` values, the installer restores
them before continuing.

## Analytics

`ballin-scripts` can send minimal anonymous active-install analytics after the
installer shows a first-run notice. It is for maintenance visibility: active
installs, top-level command usage, and command success or failure.

Disable persistently:

```shell
ballin_config set analytics.enabled false
```

Disable for one environment:

```shell
BALLIN_NO_ANALYTICS=1
```

Analytics are enabled after the notice unless disabled by config, environment,
or CI detection. CI never sends analytics. Analytics failures are ignored and
never change command output, side effects, or exit status. The installer creates
a random local install ID under `.analytics/` so the backend can count active
installs across days; the backend hashes it before storage.

Sent fields:

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

Never sent: command arguments, usernames, local paths, Gist IDs or URLs,
dotfile contents, package lists, editor settings or extensions, raw errors,
command output, environment variables, or config values.

Backend: a small Cloudflare Worker with D1 stores server-hashed daily install
IDs plus aggregate command, status, duration, version, Node, and OS counts. Rows
older than 395 days are deleted. Production sends stay disabled until
deployment, abuse controls, and final payload review are complete in
[#185](https://github.com/JBallin/ballin-scripts/issues/185). See the
[analytics backend notes](analytics-backend.md).

## `up` settings

Change a setting with `ballin_config set up.<name> true` or
`ballin_config set up.<name> false`.

| Setting | Default | Behavior |
| --- | --- | --- |
| `up.cleanup` | `true` | Runs `brew cleanup` after upgrading Homebrew packages. |
| `up.ballin` | `true` | Updates `ballin-scripts` when `up` runs. |
| `up.gu` | `false` | Runs `gu` to back up your development environment. Enable it when you want each update to also modify your backup gist. |
| `up.softwareupdate` | `true` | Installs available macOS updates with `softwareupdate`. |
| `up.nvm` | `false` | Installs the latest Node.js LTS release through a configured nvm installation. See [Node.js](#nodejs) for the setup and tradeoffs. |
| `up.npm` | `false` | Runs `npm update -g` across globally installed packages. This is a separate update step from the npm version supplied with Node.js. It defaults to `false` because it can change all global tools at once, while many tools can instead stay project-local or run through `npx`. |
