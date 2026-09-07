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
$ npm install
# MAKE CHANGES
$ npm test
$ git push --set-upstream fork "$BRANCH_NAME"
```

For more repo context, see [AGENTS.md](AGENTS.md).

For deeper user and maintainer documentation, see the
[documentation index](docs/README.md).

## Suggestions Welcome

Please open issues (or PRs) with any suggestions for additions to `ballin backup`, `ballin update`, or anything else.
