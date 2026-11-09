# Experimental installation-owner chooser

This is an unpublished, disposable-guest candidate, not a new public Quickstart,
a release, an accepted installation policy, or a version-1.0 commitment. Public
release/branch/SHA selection is unchanged. Start with the local frozen transport
below rather than substituting an unqualified formula for a requested release.

## Prepare and run

After reviewing and committing this candidate, prepare from a clean checkout with
Node 26 (the command only writes a new local artifact directory):

```sh
node experiments/homebrew/prepare-frozen-direct.cjs "$PWD" /absolute/new/artifact
SHA=$(git rev-parse HEAD)
```

Copy the complete artifact directory into a dedicated disposable VM input. In the
guest, extract the archive into a dedicated working directory, then run its chooser
from an interactive native Terminal. The SHA must be the recorded preparer SHA:

```sh
mkdir -p "$HOME/ballin-choice-source"
tar -xzf /absolute/guest/artifact/source.tar.gz -C "$HOME/ballin-choice-source"
/bin/bash "$HOME/ballin-choice-source/ballin-scripts/experiments/homebrew/run-choice.sh" \
  /absolute/guest/artifact FULL_FROZEN_COMMIT_SHA
```

Use a clean guest/snapshot for each scenario. Do not run this on a real user's host
or mount their HOME, credentials, SSH agent, GitHub sessions, or installation.
Keep the artifact SHA/checksum and exact guest version/architecture with the run
record in [the installation matrix](../../docs/installation-testing.md).

## Choices and boundaries

- **Homebrew:** use the native standard prefix. If absent on Apple Silicon, ask
  before downloading Homebrew's current official installer from its documented
  repository and executing those bytes unchanged. Print the source URL/SHA256;
  preserve its TTY, sudo, consent and developer-tool prompts. Do not set
  NONINTERACTIVE or pipe answers. Download/installer failures stop this route.
  Partial prefixes require manual inspection, not repair. Current upstream new
  Intel bootstrap is unsupported; no historical installer or source-build escape.
- **Existing Brew:** verify executable/prefix, use its Bash `shellenv` only in the
  current process, and offer a separately consented shell startup append after
  package installation. A translated/Rosetta process is rejected for the Brew
  route. Existing native Intel Brew may work but is not certified by fixtures.
- **Package:** separately ask to create the guest-local `ballin-local/choice` tap
  and install Node plus `ballin-local/choice/ballin-experiment`. This uses Brew's
  `tap-new --no-git`, with developer mode scoped to that one command, and installs
  a qualified formula, not a forbidden standalone formula path. Nothing is
  published. The tap retains the checksum-pinned archive for later retries.
  An existing tap source/formula must match exactly; changing candidates requires
  explicit inspection. Do not force links. Verify installed development marker,
  source SHA, archive hash and linked command before `setup --initial`.
- **Without Homebrew:** reuse the real Quickstart, installer, exact-SHA updater
  and onboarding through the [frozen transport](FROZEN-TRANSPORT.md). The explicit
  `BALLIN_EXPERIMENT_INSTALL_OWNER=direct` invocation disables Brew discovery and
  command-directory probes even if Brew is present. Existing compatible tools
  may be used regardless of their origin. No Brew executable is invoked.

The frozen direct transport requires working guest Git/CLT because a transport
wrapper cannot retain the identity of Apple's unprovisioned Git shim. That case
must not count as a real missing-CLT direct bootstrap test. Missing Node can still
use the real consented NVM path. Existing official-prerequisite fixtures retain
arm64/x86_64 coverage; native Intel execution remains unverified.

## State, shell safety and recovery

Prototype conventions intentionally remain different: direct code/preferences use
`~/.ballin-scripts` with `~/.local/bin/ballin`; package preferences use `~/.ballin`
with Brew-owned code/links. No XDG redesign, migration, or automatic state import.
The direct-owner environment mode is invocation-scoped, not a durable new receipt.
Do not claim persistent dual-owner self-update/uninstall behavior from this
candidate. Later direct lifecycle experiments must retain that explicit mode and
be reviewed separately; ordinary commands after exit retain existing behavior.

Bash startup uses `.bash_profile` but defers to manual setup if `.bash_login` or
`.profile` exists. Zsh uses `ZDOTDIR/.zprofile` or `~/.zprofile`. Unsupported shells,
existing Brew setup, linked/unsafe files or parents, invalid UTF-8 and invalid
shell syntax require manual setup. Consent snapshots file content/identity and
parent identity; recheck before append. Existing bytes and permissions are retained.
This is a cooperative-user filesystem guard, not a defense against a malicious
concurrent same-user process. Declining leaves installation intact and reports
future-shell activation as manual. Completion setup remains shared onboarding's
existing separate guidance.

On official refusal/interruption, inspect upstream output and retry explicitly.
If Brew succeeds but Node/package fails, leave Brew and partial package state for
inspection; rerun discovers existing Brew instead of reinstalling it. Never
silently change the owner, remove Brew, force a link, or overwrite an existing tap
with a different candidate. A preinstalled different Ballin package is not silently
upgraded or onboarded as if it were this candidate.

## Focused validation and remaining evidence

```sh
node --test experiments/homebrew/*.test.cjs
npm run lint
npm run typecheck
npm run release:check
npm run test:unit -- test/install.test.ts test/install_setup.test.ts test/nvm.test.ts test/homebrew_installation.test.ts
npm run test:unit -- test/quickstart.test.ts --grep 'experimental direct|installs missing official prerequisites|manual NVM'
```

The chooser tests use native PTYs via system Python 3 and controlled fake upstream,
Brew and package commands. They cover terminal preservation, cancellation, refusal,
download failure, Intel/partial-prefix refusal, prepared Brew, package retry,
stale marker rejection and no-Brew dispatch. Separate native profile checks cover
Bash/Zsh, existing-byte preservation, symlink/hardlink/concurrent-edit refusal,
parent replacement, invalid bytes and ZDOTDIR. The public QA sandbox does not yet
include this experimental entrypoint; the focused PTY harness is its walkthrough.
No test handles real passwords or live GitHub authentication.

These checks are not a full regression-suite pass, a live official-installer run,
or a repeat of prior package lifecycle evidence. Real new-Brew and prepared-Brew
runs, shell activation, no-Brew frozen direct execution, architecture/OS limits,
final current-stack reconciliation and release publication review remain separate
matrix cells. Preserve cancelled/failed attempts as such, with exact source and
upstream installer checksums; do not relabel fixture evidence as real installation.

## Real-guest evidence

The [November 9 verification record](../../docs/installation-test-runs/2026-11-09-choice-candidate.md)
records tests of original frozen source `919fb5b`: clean and prepared Homebrew
installation, bounded Zsh activation/profile decline, competing-owner refusal,
and prepared direct installation. It distinguishes incomplete attempts, invalid
probes, test-harness side effects and untested lifecycle/platform cases.
This checkpoint retains that executable source with revised documentation and
new Git history; no VM test against its new commit is claimed.
