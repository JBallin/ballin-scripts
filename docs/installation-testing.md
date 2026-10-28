# Installation testing

Test Ballin in a disposable macOS VM on an Apple Silicon Mac. Use disposable
data and review any authentication, backup destination, sensitive-source, and
upload choices before agreeing to them.

## Create a test VM

In **host Terminal**, install Tart:

```shell
brew install openai/tools/tart
```

Choose a supported vanilla macOS image compatible with your host and Tart from
the [available images](https://github.com/cirruslabs/macos-image-templates).
Replace the image below if needed. Choose a new VM name and clone the image:

```shell
tart clone ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest ballin-test &&
  tart run --no-audio --no-usb-accessories ballin-test
```

In the guest, open Terminal and check that the keyboard and network work. The
[Golden Gate vanilla image](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-golden-gate.pkr.hcl)
uses the public guest login `admin` / `admin`. Other images may differ; these
are not host or personal credentials.

A vanilla image has provisioning changes and is not necessarily identical to a
new Mac. If its security settings allow apps from Anywhere, change the guest's
System Settings → Privacy & Security to **App Store and identified developers**,
using the guest administrator password.

For another fresh test, create a new clone. Restarting a used VM keeps its
installed software and settings.

## Test installation

In **guest Terminal**, follow the [published Quickstart](quickstart.md). After a
successful setup, open a new Terminal, run `ballin help`, and try typing
`ballin upd` followed by Tab if you enabled completion.

Useful cases include:

- **Missing prerequisites:** Start with a vanilla guest without Homebrew,
  Command Line Tools, or Node.js. Quickstart offers the missing tools; accepting
  the prompts should complete setup.
- **Decline:** In a guest without Node and Ballin, decline the installation at
  the Proceed prompt. Node and Ballin should remain unavailable.
- **Direct installer:** In a fresh guest with Git and a supported Node.js
  already available, follow the [direct installation instructions](../README.md#installation).
  Homebrew is optional. Successful setup should leave `ballin help` working in a
  new Terminal.

## Optional: test a lost connection

Use a disposable guest that already has Ballin and a working backup destination
configured. Run `ballin backup list` online first. In **guest Terminal**, find
and disconnect the guest's default network interface, leaving the host connected:

```shell
interface=$(route -n get default | awk '/interface:/{print $2}')
printf '%s\n' "$interface"
```

Confirm this is the guest's network interface before running:

```shell
sudo ifconfig "$interface" down
ballin backup list
sudo ifconfig "$interface" up
```

The offline list should fail with a connection error. Once the guest reconnects,
run `ballin backup list` again; it should list the saved snapshots. This is a
read-only check.

## Troubleshooting

If Homebrew reports `Refusing to load formula openai/tools/softnet from untrusted tap openai/tools`, review the formula and [Homebrew's Tap Trust policy](https://docs.brew.sh/Tap-Trust).
Trust lets Homebrew execute its Ruby code. If you accept this dependency, run in
**host Terminal**, then retry the install:

```shell
brew trust --formula openai/tools/softnet
brew install openai/tools/tart
```

Use formula-only trust; do not disable trust checks. See [Tart issue #1368](https://github.com/openai/tart/issues/1368).
If guest installation runs out of space, stop and address storage for that image
before retrying. If you changed the guest's security setting, `spctl --status`
can check that assessments are enabled.

## Clean up

Save any needed results. If you signed in to GitHub in the guest, use
`gh auth logout` there and check `gh auth status` without showing tokens; sign
out of the guest browser too. Local logout does not revoke the token or remove
it from other clones; see [GitHub CLI logout](https://cli.github.com/manual/gh_auth_logout).
Then shut down the guest and delete only the selected, approved disposable VM.

VM deletion and logout do not delete a remote backup. After testing, delete a
private test repository only after verifying its exact owner, identity, and
disposable contents and obtaining explicit approval for that repository. Do not
infer that a real backup is disposable.
