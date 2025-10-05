# Contribution Guidelines

## Setup

1. Run the install script
2. Fork the repository on GitHub
3. Set the fork as a remote: `git remote add fork $FORK_REPO`

## Development

```shell
$ cd $HOME/.ballin-scripts
$ ballin_update # Update project/config
$ git checkout -b $BRANCH_NAME
$ cp config/ballin.json ../Desktop # Stash config
$ npm install
# MAKE CHANGES
$ npm test
$ mv ../Desktop/ballin.json config # Restore config
$ git push --set-upstream fork $BRANCH_NAME
```

## Suggestions Welcome

Please open issues (or PR's) with any suggestions for additions to `gu`/`up` or anything else.
