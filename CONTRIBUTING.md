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

Start new work by updating the installed checkout before creating your feature
branch. `ballin self-update` fetches `origin/main`, checks out `main`, and merges
`origin/main`. Run it before creating or switching to your feature branch;
otherwise it switches away from that branch and may stash changes during
recovery. Commit or stash any existing work first.

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

For faster focused testing and the additional hosted CI checks, see
[Testing and coverage](docs/testing.md). Agent instructions and more repo
context live in [AGENTS.md](AGENTS.md).

For deeper user and maintainer documentation, see the
[documentation index](docs/README.md).

## Feedback and Discussions

Questions, feedback, and ideas are welcome in [Discussions](https://github.com/JBallin/ballin-scripts/discussions). Report bugs in [Issues](https://github.com/JBallin/ballin-scripts/issues). For security issues, see our [security policy](https://github.com/JBallin/ballin-scripts/security/policy).
