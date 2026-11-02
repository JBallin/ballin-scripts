# Contribution Guidelines

## Setup

1. Run the [install script](README.md#installation). Use the installed checkout
   at `~/.ballin-scripts` for contributor development; its `origin` points to
   the upstream `JBallin/ballin-scripts` repository.
2. Fork the repository on GitHub.
3. From `~/.ballin-scripts`, add your fork as an additional push remote without
   replacing `origin`:

   ```shell
   git remote add fork "$FORK_REPO"
   ```

## Development

For development, use the [main-tracking environment default](docs/installation.md#selecting-a-revision).
Self-update refuses unsafe local work and confirms track changes. Preserve work
before updating, then create your feature branch. It never automatically stashes
or merges changes. Use a separate worktree when working alongside an installation.

```shell
$ cd ~/.ballin-scripts
$ ballin self-update
$ git checkout -b "$BRANCH_NAME"
$ nvm use # If you use nvm
$ npm ci
# MAKE CHANGES
$ npm test # Comprehensive local Node checks
$ git push --set-upstream fork "$BRANCH_NAME"
```

Open a pull request from your branch to `JBallin/ballin-scripts` and summarize
the change and how you tested it.

For faster focused testing and the additional hosted CI checks, see
[Testing and coverage](docs/testing.md). Agent operational instructions live in
[AGENTS.md](AGENTS.md).

For deeper user and maintainer documentation, see the
[documentation index](docs/README.md).

## Feedback and Discussions

See [Support](SUPPORT.md) for questions, bug reports, and private security reporting.

For release preparation and publication approval, see [Releasing Ballin](docs/releasing.md).
