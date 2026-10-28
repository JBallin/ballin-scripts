# Installation testing

*Maintainer guide to testing the published Ballin installation in disposable macOS VMs.*

Use the latest supported macOS vanilla image compatible with your host and Tart.
Choose that target afresh; the [recorded results](#recorded-results) below describe
specific runs, not a promise that a newer image or Ballin revision passed.
Keep host Terminal commands and guest Terminal commands separate throughout.

## 1. Prepare Tart on the host

Use an Apple Silicon Mac and check the current [Tart Quick Start](https://github.com/openai/tart/blob/main/docs/quick-start.md)
and the selected image's host requirements. Before replacing an existing Tart,
record its path/version, storage location, and VM inventory. Compare the offered
Homebrew version with the working version: a tap can lag a standalone release.
Do not downgrade or move existing VM storage during an active test.

**Host Terminal:**

```shell
sw_vers
uname -m
brew --version
command -v tart
tart --version
```

If Tart is absent, that last pair will fail; record absence. The current upstream
Homebrew route is:

```shell
brew install openai/tools/tart
```

Review the installation and dependency changes before proceeding. Then verify
`command -v tart`, `tart --version`, and `brew list --versions tart softnet`.
An old launcher with an absolute standalone-app path will still use that copy;
update and verify the intended launcher deliberately. Softnet being installed
does not mean the VM uses `--net-softnet`. The tested launch below uses default
networking; no host DHCP changes are part of this procedure.

### If Homebrew refuses the Softnet dependency

The observed error was `Refusing to load formula openai/tools/softnet from
untrusted tap openai/tools`, also reported in [Tart issue #1368](https://github.com/openai/tart/issues/1368).
Only if you encounter that error, review the named canonical formula and
[Homebrew's Tap Trust policy](https://docs.brew.sh/Tap-Trust). Trust permits
Homebrew to execute the package definition's Ruby code with your user privileges.
If you accept that specific dependency, grant formula-only trust, then retry:

```shell
brew trust --formula openai/tools/softnet
brew install openai/tools/tart
```

Do not grant trust automatically, trust the whole tap for this workaround, or
disable trust checks. Fully qualified installation normally trusts the requested
item; this observed refusal concerned its Softnet dependency.

## 2. Choose an image and preserve a clean baseline

Use the normal `~/.tart` home. If you already use another `TART_HOME`, inventory
that location first; unsetting it selects a different home and does not migrate
anything. Use the same environment for each host command and launcher:

```shell
unset TART_HOME
export TART_NO_AUTO_PRUNE=1
tart list
df -h "$HOME"
du -sh "$HOME/.tart"
```

Disabling automatic pruning preserves cached evidence during testing; monitor
host space and stop if it is insufficient. `tart list` reports virtual capacity
separately from stored size. APFS clones can share allocated blocks, and a tag
and digest can name the same cached image. Do not sum capacities or aliases to
estimate reclaimable space; compare allocated usage and host free space before
and after deliberate cleanup.

Select a **vanilla** image from the [vendor image packages](https://github.com/orgs/cirruslabs/packages?tab=packages&q=macos-)
and check its [provisioning template](https://github.com/cirruslabs/macos-image-templates).
Record the requested tag and resolved digest. Replace the placeholders below
and choose names absent from the current inventory. Clone by the resolved digest
to keep the baseline tied to that image:

```shell
image_tag='<supported-vanilla-image:tag>'
tart pull "$image_tag"
tart list
# Record the matching image digest from the pull/cache inventory.
image_digest='<same-image@sha256:digest>'
baseline='ballin-clean-baseline'
tart clone "$image_digest" "$baseline" &&
  tart get "$baseline" &&
  tart run --no-audio --no-usb-accessories "$baseline"
```

Keep the image's CPU, memory, disk, and display settings unless you deliberately
change them; save `tart get` output and any `tart set` commands. Do not add host
folder sharing. Clipboard operation in the tested vanilla guests is unverified.

### Prepare the guest before Ballin

Confirm the desktop, Terminal, keyboard input, and network work. For the tested
Cirrus Golden Gate vanilla image, the public guest username and password are
both `admin`, as defined in its [provisioning template](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-golden-gate.pkr.hcl).
These are image-specific disposable guest defaults, not host, Apple Account,
personal, or universal macOS credentials. Recheck them when changing images;
never put custom passwords in evidence.

**Guest Terminal:**

```shell
sw_vers
df -h /
spctl --status
command -v brew ballin node gh
xcode-select -p
```

Missing tools or an unselected developer directory can be expected in a clean
case. Record those results without installing anything to make preflight pass.
Also check that `~/.ballin-scripts` is absent and review any preinstalled tools
or account sessions; no PATH output alone does not prove filesystem absence.
Start signed out of GitHub CLI/browser and Apple Account. If `gh` exists, use
`gh auth status` without displaying tokens.

A provisioned vanilla VM is not automatically a stock fresh Mac: the tested
template includes automatic login, passwordless sudo, and disabled Gatekeeper.
Record the initial `spctl --status`. If assessments are disabled, use guest
System Settings → Privacy & Security to restore **App Store and identified
developers**, authenticating with the guest administrator account. Recheck for
`assessments enabled` before Ballin testing and record the final state. Stop if
you cannot restore it; do not assume all images start disabled.

Check usable guest space, not only the virtual disk size. Start unresized when
testing stock-image capacity. If an installer blocks on storage, save the error,
capacity, and free space before recovery. Stop and plan storage recovery
separately for that image/version. Before resuming, record the exercised resize
command on a stopped disposable clone and verify filesystem expansion and usable
space inside that guest. The older 100 GB preparation did not establish a minimum or a reproducible manual
partition-edit recipe; none is prescribed here.

Shut down the prepared guest normally. Confirm it is stopped in the host
inventory and retain it as the **pre-Ballin baseline**. For each fresh case,
clone that stopped baseline into a new unused name, then launch the clone:

**Host Terminal:**

```shell
test_vm='ballin-install-test-01'
tart clone "$baseline" "$test_vm" &&
  tart run --no-audio --no-usb-accessories "$test_vm"
```

Reopening a used guest retains its changes. A clone of an installed guest is
useful for lifecycle checks, but is not a clean first-install case.

## 3. Follow the published installation in the guest

Identify the scenario first: missing prerequisites or prerequisite-ready,
Homebrew present or absent, and backups Yes or No. Use disposable data.
For the clean no-Homebrew case, leave CLT, Node.js, and Homebrew absent and let
the normal prompts exercise prerequisite installation. Do not silently add tools
or treat a separately recovered/resumed run as a clean pass.

In **guest Terminal**, run `cd /tmp`, then follow the [published Quickstart](quickstart.md)
in order, using its current command. For a prerequisite-ready direct-installer
case, use the [published direct installation](../README.md#installation).
Homebrew is an example scenario, not a direct-installer requirement.
Review [installation effects and recovery](installation.md) before accepting
prompts. GitHub authentication, backup destinations, sensitive sources, and
uploads need deliberate authorization; declining backups is a valid test.

Save sanitized output, choices, timings, exit status, and any recovery steps.
After setup, open a **fresh guest Terminal** and check:

```shell
command -v ballin
ballin help
git -C "$HOME/.ballin-scripts" rev-parse HEAD
df -h /
```

Try `ballin upd` followed by Tab and confirm it completes to `update`. Inspect
the actual checkout/config, command link, and selected shell startup file;
compare them with the installer messages and check for duplicate additions after
reruns. Expected locations are described in [installation changes](installation.md#what-installation-changes).

## 4. Keep evidence, then clean up deliberately

Record the test date, intended Ballin SHA, actual installed SHA, host/guest
macOS versions and builds, image tag/digest, Tart/Homebrew/tool versions,
resources, launch flags, initial/final security and space, scenario, results,
and departures from the published flow. Distinguish viewed output from a
tester's report, failures from recoveries, and clean installs from resumed runs.

The checkout SHA identifies only the checkout. Quickstart and its nested
installer may download moving `main`; retain actual bytes/hashes when available,
otherwise record **published main; exact executed revision not captured** for
each. Do not change the normal journey just for instrumentation or infer a
checkout SHA from a fetch message or backup commit. Exclude tokens, device codes,
credentials, private backup contents, and personal paths from shared evidence.

Save evidence outside the VM before teardown. Inside the **exact selected test
guest**, log out the intended account with `gh auth logout`, then verify signed
out with [`gh auth status`](https://cli.github.com/manual/gh_auth_status), without
showing tokens. Sign out of guest browser sessions too. Local logout does not
revoke the server-side token or remove copies in other clones; see the
[logout/revocation distinction](https://cli.github.com/manual/gh_auth_logout).
App-wide GitHub CLI revocation affects other devices and is not routine cleanup
for a private disposable VM with no known exposure. Preserve the host login.

After testing finishes, shut down normally and review a specific VM/cache
inventory. Delete only the identified, approved disposable VM after needed
evidence is saved. Preserve clean baselines, evidence guests still needed,
and any separate browsing VM. Recheck inventory and measured host storage;
do not infer deletion savings from virtual disk capacities.

Deleting a VM or signing out does not delete a remote backup repository. If a
private repository was created for testing and is no longer needed, wait until
testing is complete and evidence is preserved. Verify its exact owner, repository
identity, and disposable contents, then obtain explicit approval for deletion of
that exact remote repository. Never infer that a maintainer's real backup is a
disposable test repository.

## Recorded results

These bounded user-led tests were recorded in October 2026. Viewed output and
direct host checks are identified separately from user reports. They do not
qualify every scenario or the current moving `main`.

### Host route: October 27 Pacific / October 28 UTC

Direct checks verified macOS **27.0.1 / 26A434**, arm64, Homebrew **7.0.11**,
Homebrew Tart **2.41.1**, Softnet **0.24.1**, and the actual `/opt/homebrew`
binaries. The user installed after granting only formula-level Softnet trust.
The default `~/.tart` inventory was verified with `TART_HOME` unset; existing
VMs/caches were preserved. No downgrade occurred. One clean-template launch
with `--no-audio --no-usb-accessories` reached the desktop by user report;
later inventory showed it stopped. Its launch-session exit status was unavailable.
Neither `--net-softnet` nor a DHCP change was exercised.

### Unresized Quickstart: October 27

- **Image:** `ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest`, recorded
  digest `sha256:b78a521145ebef24e9916c0b3999e165bb12b587d11524c5fa3ba4fe7bf79bb9`;
  the guest was cloned by digest. The template and earlier prepared baseline
  identify macOS **27.0 / 26A428**; this run's spoken preflight reported macOS
  **27**, without independently recapturing the full build.
- **Baseline:** 50 GB virtual disk, 41 GiB root volume, 11 GiB free; no
  `brew`, `ballin`, `node`, or `gh` on PATH and no active developer directory
  by user report. Initial Gatekeeper assessments were disabled; the user
  subsequently reported them enabled, without a captured timestamp establishing
  whether restoration preceded Quickstart. This limits security-preflight evidence.
- **Result:** viewed output shows published Quickstart from `/tmp`, backups No,
  CLT **27.0** and Node.js **24.22.1** installed, checkout under
  `$HOME/.ballin-scripts`, profile/completion accepted, setup complete, and the
  prompt returned in `/tmp`. Fresh-Terminal PATH (`~/.local/bin/ballin`), help,
  completion, and 8.9 GiB remaining passed by user report. No resize was needed.
- **Revision:** the user read installed prefix `500ce20e34c5a100`, matching
  merge revision `500ce20e34c5a100af340ff666efdc2dc9dea23a`; the full installed
  SHA was not read back. Outer/nested downloads used published `main`; their
  exact executed revisions were not captured. This was before the later
  Homebrew Tart migration; guest results used the earlier standalone Tart 2.41.1.

### Other bounded results and limitations

| Date / case | Observed result | Limits |
| --- | --- | --- |
| October 23, Golden Gate with Homebrew, missing Node, backups Yes | Viewed output reports setup and first backup success; user reports fresh-Terminal help and tab completion. Reported Node 26.12 and GitHub CLI 2.102.1. | Earlier prepared 27.0 / 26A428 baseline; Homebrew version and executed outer/nested/checkout SHAs not captured. Private remote contents not independently verified. |
| October 26–27, no-Homebrew setup after CLT recovery | Separate retained-marker CLT recovery succeeded; resumed setup completed. User reports help/completion and checkout prefix `4cb3abbc59c7cb3ca`. | Enlarged 27.0 / 26A428 baseline; original CLI CLT attempt failed. Resumed success is not a clean bootstrap pass; full checkout/download SHAs unknown. |
| October 27, lifecycle clone of successful stock guest | Viewed rerun completed; user reports help/completion. First uninstall removal was checked by user; direct decline/reinstall and Quickstart decline/reinstall completed within recorded output/reports. Final Quickstart fresh-Terminal help/completion passed by user report. | Reused prerequisites, not fresh missing-tools cases. Final installed SHA unknown; direct reinstall fresh-shell function and final profile deduplication not independently checked. |
| October 27, read-only offline/reconnect | User reports `ballin backup list` exit 1 in 0.437 s disconnected, then exit 0 in 2.534 s restored. Self-update success also reported. | Final self-update SHA unknown. No offline upload, full update, or bootstrap/install qualification. |
| October 28, Homebrew present, Node missing, Quickstart declined | User reports choosing backups No and Proceed No; afterward `command -v node` and `command -v ballin` were empty, and `node -v` was not found. | Screenshot showed the preview before confirmation, not the decline. No full filesystem or profile checksum comparison or exact executed SHA was established. |

The historical Tahoe CLT block required **24.27 GB** with **19.41 GB** available.
That observation does not establish OS-specific causality. Earlier 100 GB
preparation supplied headroom; the successful stock 50 GB run rules out a blanket
100 GB requirement. Exact resource settings were not captured for every later
clone. Clipboard, all launch modes, all offline routes, and newer images/revisions
remain unqualified. Keep test metadata here; installation examples should link
here rather than duplicate this record.
