# Local frozen-source transport

This is disposable-guest experiment infrastructure, not a third installer or a
published release. It runs the actual committed Quickstart, installer and Git
revision helper with an explicit development SHA. Public bootstrap code and
stable-release checks are unchanged. Do not use it against a real installation.

## Prepare and transfer

After committing the experimental candidate and confirming the worktree is clean:

```sh
node experiments/homebrew/prepare-frozen-direct.cjs /path/to/clean/candidate /tmp/ballin-candidate
```

The new directory contains `source-sha`, `source.tar.gz` (single
`ballin-scripts/` root), `source.bundle`, four exact bootstrap files and
`SHA256SUMS`. Preparation rejects dirty/untracked work and existing output. Record
the returned full SHA and checksum manifest with the VM results. Transfer the
whole directory unchanged to a disposable guest. No network/publishing is part of
preparation. The bundle includes reachable Git history, not local configuration.

The manifest detects changed bytes, not a malicious replacement of both data and
manifest. Use only a trusted artifact prepared from the reviewed clean commit.
It is not release signing or independent authentication of source. The bundle's
commit and bootstrap contents are checked again against real Git objects before
clone/fetch installs anything.

## Run in a disposable guest

The chooser calls the following runner only after the user selects direct:

```sh
/bin/bash experiments/homebrew/run-frozen-direct.sh --verify /tmp/ballin-candidate FULL_SHA
/bin/bash experiments/homebrew/run-frozen-direct.sh /tmp/ballin-candidate FULL_SHA
```

Verification requires system shell, sed and shasum, not Node or Git. The runnable
route requires a terminal and already-working Git (Apple developer tools or a
supported independently installed Git). This is a **transport limitation**:
Quickstart detects Apple's missing-CLT shim by file identity, and wrapping it
would otherwise turn that case into a broken-third-party-Git diagnosis. Prepare
CLT separately in the guest. Do not claim this run verifies direct first-time CLT
provisioning; use existing isolated fixtures now and an exact published source
for that future native case. Node/NVM setup remains the actual Quickstart flow.

The runner makes private temporary copies and checks them, then puts two narrow
transport adapters on PATH. Curl serves only the four exact raw GitHub URLs for
the selected SHA; branch/release/other Ballin-source requests are refused. Other
downloads use the selected real curl, unchanged. Git routes clone/fetch of only
the canonical Ballin remote to the verified local bundle. Origin inspection still
sees the canonical URL, and the checkout receives the normal SHA development
receipt. No `--version` or branch selector is accepted by this infrastructure.

Git configuration overrides are scoped to child clone/fetch commands and do not
remain in the installed repository. Unrelated inherited `GIT_*` variables and
user/system Git configuration are excluded for this run. The runner sets
`BALLIN_EXPERIMENT_INSTALL_OWNER=direct`; no Brew process should run. The private
transport files are removed on exit. Real prerequisites may need downloads and
consent; no installer answers, passwords or credentials are synthesized.

Afterward ordinary `ballin self-update` uses its normal public default selection,
not this unpublished commit or local bundle. Do not use it as a frozen-candidate
upgrade test. Keep the artifact if retrying the same candidate. Remove or reset
the disposable guest according to the VM test plan, not through host cleanup.

## Isolated checks

```sh
node --test experiments/homebrew/frozen-transport.test.cjs
```

These create temporary miniature Git repositories and verify preparation,
manifest refusal, non-TTY refusal, exact-download routing, actual bundle
clone/fetch, canonical origin preservation and bootstrap/object mismatch refusal.
They never run a real installer or contact a server. They do not establish native
CLT, NVM, package-manager or interactive installation success.
