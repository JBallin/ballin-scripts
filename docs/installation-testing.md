# Installation testing

*Guide to testing Ballin installation in a disposable macOS VM.*

## Create a test VM

Install [Tart](https://github.com/openai/tart), then clone and run a test VM from Terminal on your Mac:

```shell
brew install openai/tools/tart
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla ballin-test
tart run ballin-test
```

For guest admin access and automated console command entry, see the supplemental
[gallery VM notes](../tools/output-gallery/README.md#guest-local-admin-access).

## Test installation

Follow the [installation instructions](../README.md#installation) in the VM.

## Prelaunch entrypoint recovery

Protocol-1 prelaunch entrypoints cannot select protocol-2 revisions, including
with an explicit SHA. They stop at the unsupported-contract error. This is a
candidate-testing boundary; normal maintenance uses `ballin self-update`.

To test recovery in a disposable VM, preserve the existing checkout, config and
cache first. Use the entrypoint from the reviewed protocol-2 candidate itself,
selecting that same full commit:

```shell
CANDIDATE_SHA=FULL_REVIEWED_COMMIT_SHA
/bin/bash -c "$(curl -q -fsSL "https://raw.githubusercontent.com/JBallin/ballin-scripts/$CANDIDATE_SHA/install.sh")" ballin-install --sha "$CANDIDATE_SHA"
```

Verify that declining preserves the checkout and local data, accepting installs
the exact candidate and refreshes setup, and subsequent `ballin self-update`
uses the new contract. An explicit SHA remains a commit selection; a later track
change still requires its own confirmation. Also check dirty-checkout refusal
and interrupted or failed setup recovery. Record exact revisions, outcomes and
limitations; do not count staged output as a real installation.

## Clean up

Shut down the VM, then delete it from Terminal on your Mac:

```shell
tart delete ballin-test
```

Delete the test backup repository when no longer needed.
