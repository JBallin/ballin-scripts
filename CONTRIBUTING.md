# Contribution Guidelines

### Make Changes Locally

First, make a fork of the repo and set it as a remote:
`git remote add fork $LINK_TO_FORK`

```shell
$ cd $HOME/.ballin-scripts
$ ballin_update
$ git checkout -b $BRANCH_NAME
$ cp config/ballin.json ../Desktop
$ npm install
# MAKE CHANGES
$ npm test
$ git push --set-upstream fork $BRANCH_NAME
$ mv ../Desktop/ballin.json config/
```

### Suggestions Welcome

Please open issues (or PR's) with any suggestions for additions to `gu`/`up` or anything else.
