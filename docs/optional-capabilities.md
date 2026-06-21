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

After installing `ballin-scripts`, optionally let `up` install newer LTS
releases:

```shell
ballin_config set up.nvm true
```

`up.nvm` runs `nvm install --lts`; it does not update nvm itself. It defaults to
`false` because enabling it opts into the LTS release, and installing a new
Node.js version does not migrate your globally installed npm packages
automatically. If nvm cannot be loaded, `up` warns and continues with its
remaining updates.

For a simpler setup, install Homebrew's current Node.js release instead:

```shell
brew install node
```

With this option, Homebrew manages Node.js updates along with your other formulae.
The `up.nvm` setting does not apply.

The installer's missing-Node detection and guidance are tracked separately in
[#60](https://github.com/JBallin/ballin-scripts/issues/60); this guide is the
canonical reference for choosing and setting up a Node.js installation method.

## Mac App Store apps

Follow the official
[`mas` installation instructions](https://github.com/mas-cli/mas#installation) to
add Mac App Store support.

When `mas` is available, `up` updates installed App Store apps and `gu` includes
the installed-app list in your backup. No configuration setting is required.

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
| `up.npm` | `false` | Updates all globally installed npm packages. This is separate from the npm version bundled with Node.js; many tools can instead stay project-local or run through `npx`. |
