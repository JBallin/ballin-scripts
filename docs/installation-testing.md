# Installation testing

*Guide to testing Ballin installation in a disposable macOS VM.*

## Create a test VM

Install [Tart](https://github.com/openai/tart), then clone and run a test VM from Terminal on your Mac:

```shell
brew install openai/tools/tart
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla ballin-test
tart run ballin-test
```

## Test installation

Follow the [installation instructions](../README.md#installation) in the VM.

## Clean up

Shut down the VM, then delete it from Terminal on your Mac:

```shell
tart delete ballin-test
```

Delete the test backup repository when no longer needed.
