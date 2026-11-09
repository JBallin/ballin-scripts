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

## Plan a test run

Use this matrix before changing installation ownership, prerequisites, shell
setup or update behavior. Select the rows affected by the change and record why
other rows are deferred or not applicable. It is not a requirement to run every
combination, rebuild the gallery, or repeat real tool downloads for every PR.
[Testing and coverage](testing.md) remains the source for automated review gates.

Homebrew package distribution and the Quickstart choice between installing
Homebrew and installing without it are experiments tracked in [#17](https://github.com/JBallin/ballin-scripts/issues/17).
Include their rows when evaluating those candidates; do not present them as
released installation methods or an approved version-1.0 requirement.

For each selected row, record the exact source commit, installation owner,
starting state, expected result, environment and evidence type. A clean synthetic
HOME in a prepared guest is not a clean operating system. Record which tools were
already installed, including tools hidden from PATH.

### Installation matrix

| ID | Starting state or action | Verify |
| --- | --- | --- |
| I1 | Direct install with compatible Node.js and Git | Exact revision and owner; planned paths; no unnecessary prerequisite install; command works in the intended shell. |
| I2 | Quickstart without Homebrew, Node.js or Git | Consent for required tools; official prerequisite route; developer-tool requirements; new-shell activation; successful retry after a declined or failed step. Record tools merely hidden from PATH separately. |
| I3 | Choose the direct route with Homebrew present | Choice remains direct; no implicit Brew install, update or package ownership; correct direct updater and removal behavior. |
| I4 | Choose a package route with working Homebrew | Reuse existing Brew without replacing its setup; correct runtime and formula; shared onboarding; no forced links or writes to a keg. |
| I5 | Choose a package route without Homebrew | Official installer retains its terminal and consent/admin prompts; prerequisite and permission failures remain visible; verify Brew before installing Ballin. |
| I6 | Interrupted or partial Brew/package install | No silent route switch or false success. Retry reuses completed prerequisites. Preserve existing Brew, unrelated packages and user files; never repair permissions or delete a prefix implicitly. |
| S1 | Bash/Zsh startup absent, existing or customized | Current-process and fresh-shell command resolution; correct startup file, including ZDOTDIR and relevant Bash startup patterns; explicit separate consent; no duplicate setup on rerun. |
| S2 | Startup consent declined, unsafe file or concurrent edit | Preserve file bytes/mode/link target; keep completed installation; give executable manual activation; report future-shell activation as unverified when appropriate. |
| C1 | Invalid input, default answer, EOF, interruption or no TTY | Prompt retry and cancellation are truthful; no accidental acceptance, hidden unattended install or later stage after refusal; saved earlier choices survive retry. |
| O1 | Another installation, contributor clone, shadowed or dangling command | Verify owner and active command before writes. Refuse unsafe takeover; preserve the other installation and developer work. |
| U1 | Upgrade and state retention | Correct owner updates code; configuration, identity and required state survive; portable preference backup reads the active configuration; unsupported schemas/runtime transitions fail safely. |
| U2 | Upgrade during maintenance, failure and cleanup | Running code/runtime remain available until later stages finish; failure/interruption retains recovery material; completion helpers survive permitted keg cleanup. |
| R1 | Uninstall and reinstall | Remove only the selected owner's code/links; retain user state by the documented contract; do not remove shared prerequisites or another installation; rerun works. |
| P1 | Published release and formula provenance | Exact released tag/commit/archive checksum and owner; unsupported selectors rejected explicitly; no latest/main fallback or development receipt described as a release. |

### Environment coverage

Record these dimensions for the selected cases rather than implying that one
successful VM covers every combination:

- Architecture and execution mode: native Apple Silicon, native Intel, or a
  translated process. State the macOS version and whether upstream currently
  supports installing Homebrew there. Do not equate an existing working Brew
  installation with support for a new installation.
- Shell: Zsh and Bash; current process, fresh login shell and relevant interactive
  nonlogin shell. Note custom startup locations, existing NVM/Brew code and PATH
  precedence when they affect the case.
- Prerequisites: absent, compatible, incompatible, present but not on PATH, or
  partially installed. Record the actual Node.js, Brew and developer-tool versions.
- Permissions and input: administrator/nonadministrator where relevant; declined
  administrator prompt; TTY versus redirected input; writable, read-only, symlinked
  or concurrently edited startup/configuration paths.

Use controlled fixtures for network failures, permission refusal, interruption
and partial outcomes that would otherwise require changing real accounts or
breaking a machine. Use disposable VMs for actual installation and native shell
integration. A fixture can verify handling an admin denial; it does not establish
that the official installer works for a real nonadministrator account.

### Record and reuse results

Use **pass**, **fail**, **blocked**, **not run** or **not applicable**, with a reason.
A pass applies only to the named case and evidence type:

- **Real VM:** actual installation/tool behavior in the recorded guest.
- **Native PTY:** actual command and terminal handling with scripted input.
- **Fixture:** controlled tools, services or filesystem inputs; identify what was
  substituted. A throwaway adapter is not the shipped Quickstart.
- **Static inspection:** source evidence only, not an executed case.

For each result keep: matrix ID, exact candidate and upstream source identities,
VM/template and prerequisite state, command or harness version, expected/actual
outcome, exit status, raw-log location, preserved-state checks and limitations.
Record partial failures before a corrected rerun; an exit file alone is not proof
of success when the log shows a failure. Do not record passwords, tokens or real
backup contents. Keep generated logs and captures outside Git, with a stable
handoff location; commit concise findings and source references when useful.

Before running another batch, inspect its prior receipts. Reuse unchanged evidence
with its original revision and limits; rerun affected behavior after changes.
For example, changing an installer wrapper calls for refusal/retry/TTY checks,
while changing state resolution calls for configuration, analytics, backup,
completion and uninstall checks. Do not silently extend an earlier result to a new
candidate. For a release candidate, follow the exact-merged-source requirements in
[Releasing Ballin](releasing.md).

The [November 9 Homebrew assessment](installation-test-runs/2026-11-09-homebrew.md)
applies this matrix to the preserved prototype, current upstream inspection and
isolated route experiments. It includes a failed preference-discovery case and
explicit gaps; it is not a release-readiness declaration.

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
