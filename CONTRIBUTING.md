# Contribution Guidelines

## Setup

1. Run the [install script](README.md#installation)
2. Fork the repository on GitHub
3. Set the fork as a remote: `git remote add fork $FORK_REPO`

## Development

```shell
$ cd $HOME/.ballin-scripts
$ ballin_update # Update project/config
$ git checkout -b $BRANCH_NAME
$ npm install
# MAKE CHANGES
$ npm test
$ git push fork $BRANCH_NAME
```

## Suggestions Welcome

Please open issues (or PR's) with any suggestions for additions to `gu`/`up` or anything else.
