# Installation testing

*Maintainer guide to testing the published Ballin installation in disposable macOS VMs.*

Use the latest supported macOS vanilla image compatible with your host and Tart.
Choose that target afresh; the [recorded results](#recorded-results) below describe
specific runs, not a promise that a newer image or Ballin revision passed.
Keep host Terminal commands and guest Terminal commands separate throughout.

## 1. Prepare Tart on the host

Use an Apple Silicon Mac. Check the current [Tart Quick Start](https://github.com/openai/tart/blob/main/docs/quick-start.md) and image requirements. Before replacing Tart, record its path, version, storage, and VM inventory; compare the offered Homebrew Tart version with the installed Tart version to avoid a downgrade. Do not move storage during testing.

**Host Terminal:**

```shell
sw_vers
uname -m
brew --version
command -v tart
tart --version
```

If Tart is absent, record that. The upstream Homebrew route is `brew install openai/tools/tart`. Review dependencies first, then verify `command -v tart`, `tart --version`, and `brew list --versions tart softnet`. An absolute-path launcher may still use an older copy. The tested launch uses default networking, without `--net-softnet` or a DHCP change.

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

Do not automate trust, trust the whole tap, or disable checks.

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

Keep automatic pruning disabled during testing and monitor host space. APFS clones can share blocks and image tags can alias digests; use allocated usage and free space, not summed virtual capacities, to assess storage.

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

Record `tart get` resources and any changes. Do not share host folders; clipboard support in these vanilla guests is unverified.

### Prepare the guest before Ballin

Confirm desktop, Terminal, keyboard and network. The tested [Golden Gate template](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-golden-gate.pkr.hcl) uses public guest credentials `admin` / `admin`; these are image-specific, not personal credentials. Recheck for other images and never record custom passwords.

**Guest Terminal:**

```shell
sw_vers
df -h /
spctl --status
command -v brew ballin node gh
xcode-select -p
```

Record missing tools and developer directory without preinstalling them. Check `~/.ballin-scripts` is absent, inventory other tools and sessions, and start signed out of GitHub and Apple Account. If present, use `gh auth status` without displaying tokens. PATH absence alone does not prove filesystem absence.

A provisioned vanilla VM is not automatically a stock fresh Mac: the tested
template includes automatic login, passwordless sudo, and disabled Gatekeeper.
Record the initial `spctl --status`. If assessments are disabled, use guest
System Settings → Privacy & Security to restore **App Store and identified
developers**, authenticating with the guest administrator account. Recheck for
`assessments enabled` before Ballin testing and record the final state. Stop if
you cannot restore it; do not assume all images start disabled.

Check usable guest space with `df -h /`, not just virtual capacity. For a stock-capacity test, start unresized. If storage blocks installation, save the error and free space, then plan recovery separately for that image. Record any resize command on a stopped disposable clone and verify guest filesystem expansion before resuming. A 100 GB minimum and manual partition recipe are not established.

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

Choose a disposable-data scenario: missing or ready prerequisites, Homebrew present or absent, and backups Yes or No. For a clean no-Homebrew case, do not preinstall CLT, Node, or Homebrew; let Quickstart offer missing tools. Record a recovered run as resumed, not clean.

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

Record date, intended and actual checkout SHA, host/guest OS and build, image tag/digest, tool versions, resources, launch flags, security states, free space, prompts, timings, results, and recovery. Distinguish screenshots from user reports and clean runs from resumed runs. The checkout SHA does not identify the outer Quickstart or nested installer: retain their actual bytes/hashes when available, otherwise record their executed revisions as unknown. Never infer a checkout SHA from a fetch or backup commit. Redact credentials, device codes, private contents, and personal paths.

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

These bounded user-led October 2026 tests do not qualify newer revisions.

- **Host, October 27–28:** Direct checks verified arm64 macOS 27.0.1 / 26A434, Homebrew 7.0.11, Tart 2.41.1 and Softnet 0.24.1 under `/opt/homebrew`, with default `~/.tart`. After formula-only trust, one launch reached the desktop by user report; its exit status is unknown.
- **Unresized Quickstart, October 27:** `ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest`, digest `sha256:b78a521145ebef24e9916c0b3999e165bb12b587d11524c5fa3ba4fe7bf79bb9`, 50 GB disk. The template and earlier baseline identify 27.0 / 26A428; this run reported macOS 27 without recapturing the build. Initially 11 GiB free, no brew, ballin, node or gh on PATH, no selected CLT, and Gatekeeper disabled by user report. Assessments were later reported enabled; their status before installation is unconfirmed. Output showed `/tmp` Quickstart, backups No, CLT 27.0 and Node 24.22.1 installation, checkout at `$HOME/.ballin-scripts` and setup completion. Fresh-Terminal PATH (`~/.local/bin/ballin`), help, completion and 8.9 GiB free afterward were user-reported. User-read installed prefix `500ce20e34c5a100` matches merge `500ce20e34c5a100af340ff666efdc2dc9dea23a`; full installed SHA and outer/nested download revisions were not captured. The run used standalone Tart 2.41.1.
- **October 23:** Golden Gate 27.0 / 26A428, Homebrew present (version unknown), Node missing. Setup and first backup reported success; fresh-Terminal help/completion passed by user report. Node 26.12 and gh 2.102.1 were reported; executed revisions and remote contents remain unverified.
- **October 26–27:** On an enlarged Golden Gate 27.0 / 26A428 baseline, CLI CLT failed; separate recovery and resumed setup succeeded. Help/completion and checkout prefix `4cb3abbc59c7cb3ca` were reported; this was not a clean bootstrap pass.
- **October 27 lifecycle:** Rerun, uninstall and direct/Quickstart decline and reinstall completed within viewed output and reports. Final SHA, final profile deduplication and direct reinstall fresh-shell function were not independently checked.
- **October 27 offline:** User reported read-only backup list failure offline and success after reconnect, plus self-update success with final SHA unknown. Offline upload, full update and installation remain unqualified.
- **October 28 decline:** With Homebrew present and Node missing, the user reported backups No then Proceed No; `command -v node` and `command -v ballin` were empty afterward, and `node -v` was not found. The screenshot shows only the pre-confirmation preview; full filesystem/profile equality and executed SHA are unknown.

Historically, Tahoe CLT required 24.27 GB with 19.41 GB available; OS-specific causality is unproven. The stock 50 GB success does not establish a universal minimum. Clipboard and other untested scenarios remain unqualified.
