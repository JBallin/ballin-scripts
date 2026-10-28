# Installation testing

*Guide to testing Ballin installation in a disposable macOS VM.*

## Create a test VM

Install [Tart](https://github.com/openai/tart) in **Host Terminal (your Mac)**:

```shell
brew install openai/tools/tart
```

Clone and run a test VM:

```shell
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla ballin-test
tart run ballin-test
```

## Test installation

Follow the [installation instructions](../README.md#installation) in the VM.

## Clean up

If you signed in to GitHub, run `gh auth logout` in **Guest Terminal (the VM)**.
Shut down the VM, then delete it in **Host Terminal**:

```shell
tart delete ballin-test
```

Delete any backup repositories created for testing when no longer needed.
