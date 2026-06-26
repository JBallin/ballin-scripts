# Contribution Guidelines

## Setup

1. Run the [install script](README.md#installation)
2. Fork the repository on GitHub
3. Set the fork as a remote: `git remote add fork $FORK_REPO`

## Development

```shell
$ cd /path/to/ballin-scripts
$ ballin_update # Update project/config
$ git checkout -b $BRANCH_NAME
$ nvm use # If you use nvm
$ npm install
# MAKE CHANGES
$ npm test
$ git push fork $BRANCH_NAME
```

Command implementation conventions live in [AGENTS.md](AGENTS.md).

## Suggestions Welcome

Please open issues (or PR's) with any suggestions for additions to `gu`/`up` or anything else.
