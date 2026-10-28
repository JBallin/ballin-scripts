# Installation testing

*Guide to testing Ballin installation in a disposable macOS VM.*

## Create a test VM

Install [Tart](https://github.com/openai/tart) in **Host Terminal (your Mac)**:

```shell
brew install openai/tools/tart
```

Clone and run the Golden Gate vanilla image:

```shell
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest ballin-test &&
  tart run ballin-test
```

Log in to the VM as `admin` with password `admin`.

## Test installation

Inside the VM, follow either the [Quickstart](quickstart.md) or the
[direct installation instructions](../README.md#installation). Open the
instructions in the VM's browser, then copy the command into **Guest Terminal
(inside the VM)**.

## Clean up

If you signed in to GitHub, run `gh auth logout` in **Guest Terminal (inside the
VM)**. Shut the VM down normally, then delete it in **Host Terminal (your Mac)**:

```shell
tart delete ballin-test
```

If you created a remote backup repository for this test, remove that test
repository when it is no longer needed.
