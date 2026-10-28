# Installation testing

*Guide to testing Ballin installation in a disposable macOS VM.*

## Create a test VM

On an Apple Silicon Mac, install Tart in **host Terminal**:

```shell
brew install openai/tools/tart
```

Choose a supported vanilla macOS image compatible with your host and Tart from
[the available images](https://github.com/cirruslabs/macos-image-templates).
Replace the image below if needed. Choose a new VM name, then clone and run it:

```shell
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest ballin-test &&
  tart run --no-audio --no-usb-accessories ballin-test
```

For the [Golden Gate vanilla image](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-golden-gate.pkr.hcl),
log in as `admin` with password `admin`. If guest security settings allow apps
from Anywhere, change System Settings → Privacy & Security to **App Store and
identified developers** using the guest administrator password.

For each fresh test, create a new clone; restarting a used VM keeps its changes.

## Test installation

Open the installation instructions in the VM's browser, then copy the command
into its Terminal. Choose one path:

- **[Quickstart](quickstart.md):** In a guest without Command Line Tools or
  Node.js, follow the prompts to install the missing prerequisites and Ballin.
  If you decline at the Proceed prompt, the planned installation should not run.
- **[Direct installer](../README.md#installation):** In a guest with Git and a
  supported Node.js already available, follow the direct installation steps.

After successful setup, open a new guest Terminal and run `ballin help`. If you
accepted completion setup, type `ballin upd` and press Tab to complete `update`.

If the VM has a working backup destination, you can also test `ballin backup list`.
With the VM offline, backup listing should report a connection error; after
reconnecting, it should work again.

## Troubleshooting

If Homebrew refuses to load `openai/tools/softnet` from an untrusted tap, review
the formula and, if you trust it, run in **host Terminal**:

```shell
brew trust --formula openai/tools/softnet
brew install openai/tools/tart
```

See [Homebrew Tap Trust](https://docs.brew.sh/Tap-Trust) and
[Tart issue #1368](https://github.com/openai/tart/issues/1368).

## Clean up

In **host Terminal**, stop and delete the test VM. Skip `tart stop` if it is
already shut down:

```shell
tart stop ballin-test
tart delete ballin-test
```

If you created a remote backup repository for this test, remove that test
repository when it is no longer needed.
