# Explicit installation-owner choice: verification record

November 9, 2026 UTC. Technical results for the
[installation matrix](../installation-testing.md#installation-matrix).

## Tested source and scope

The executed experimental source was commit
`919fb5b81baa7df4aa3cb2615337972d6e1832d1`, with archive SHA256
`39691bb2f9191cfa66304a93fe8756b6ce0474bc016876512f670ff79c5a517e`.
This local checkpoint preserves that candidate's executable source but has different
Git history and revised documentation. The tests below ran against the original
source, not this checkpoint's new commit or a newly generated archive.

The experiment is not a release, published tap, version-1.0 commitment or adopted
installation policy. Public release selection is unchanged. The earlier
[package prototype assessment](2026-11-09-homebrew.md) remains revision-specific.

## Local checks on the tested candidate

Node.js 26 checks passed: lint, typecheck, release metadata check, 27 experimental
tests, 238 install/setup/NVM/package tests and 15 focused Quickstart tests. Shell
and JavaScript syntax checks passed. This was not a complete aggregate regression
or CI pass; ShellCheck was unavailable in the local environment.

The experiment harness uses controlled commands and native PTYs. It covers owner
selection, terminal preservation, cancellation/refusal, download failure, partial
prefix rejection, prepared-Brew retry, source mismatch rejection and profile safety.
Fixtures do not establish real administrator-account or network behavior.

## Disposable guest results

All guests were native arm64 macOS 27.0, build 26A428. Inputs and outputs were
isolated from host installation and account data. The guests were stopped after
verification. Security settings were inspected, not changed.

| Rows | Result | Evidence and limits |
| --- | --- | --- |
| C1 | Pass, initial chooser cancellation | Selecting Cancel returned before either installation route. This is not an upstream-interruption or no-TTY VM test. |
| I5 | Pass, one clean guest | With Gatekeeper enabled and Brew/Node/CLT initially absent, the official interactive installer installed CLT 27.2 and Homebrew 7.0.12. The package route then installed Node 26.13.0_2 and the exact frozen Ballin development package, and shared onboarding completed. Final Gatekeeper inspection remained enabled. |
| I4 | Pass, prepared guest | Existing Homebrew 7.0.12, CLT and Node were reused to install the same local development package. Shared onboarding completed with backup and preference review declined. This image inherited disabled Gatekeeper and does not substitute for the clean enabled-Gatekeeper run. |
| S1 | Pass, narrow Zsh cases | Prepared-Brew run consented to a `.zprofile` shellenv addition and fresh Zsh resolved Brew/Ballin. The direct run consented to `.zshrc` PATH setup and fresh Zsh ran `ballin help` with exit 0. No Bash/customized-startup VM claim. |
| S2 | Pass, absent-profile decline | Clean Brew run declined the optional profile write. Final `.zprofile` and `.zshrc` were absent, while fresh login Zsh resolved Brew/Ballin and printed valid help through upstream `/etc/paths.d/homebrew` integration. Existing-file and concurrent-edit cases remain fixture evidence. |
| O1 | Pass, competing-owner refusal | After package installation, selecting the direct route refused the existing Brew-owned command rather than replacing it. This is not automatic migration or owner-switching support. |
| I1; I3 installation boundary | Pass, prepared direct guest | Real Quickstart and frozen Git-bundle transport installed exact tested source under a synthetic HOME, retained canonical origin and created the direct command link. Fresh Zsh ran valid help with exit 0. A PATH-first Brew tripwire recorded no calls; this is not absolute-path process tracing. |
| I2 | Not run end to end | Direct transport requires prepared Git/CLT. The direct guest also used already-installed Brew-supplied Node. This is not clean no-Brew or missing-Node/CLT provisioning evidence. |
| I6 | Partial evidence only | An initial clean-guest attempt stopped at upstream administrator authentication without confirmed interruption completion. A later attempt completed. This does not prove all interrupted-install cleanup and retry cases. |

## Installation details and interpretation

The official installer was downloaded unchanged from its documented repository.
Its tested SHA256 was
`5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148`.
The terminal and upstream administrator/RETURN confirmation prompts were preserved.
A baseline `sudo -n` success did not predict whether the interactive installer
would request authentication. No standalone Xcode agreement prompt was observed.
Homebrew's Node confirmation listed 24 dependencies and retained its ordinary
installation question; the chooser did not suppress it.

Installed package verification confirmed schema 2, development selection, exact
source/archive identifiers above and owning formula
`ballin-local/choice/ballin-experiment`. The version was
`1.0.0-dev.919fb5b81baa`. The clean guest's `brew test` returned 0. That inspection
command separately enabled Brew developer mode and fetched Ruby gems; these were
test-harness side effects after installation, not chooser behavior.

The direct checkout retained origin `https://github.com/JBallin/ballin-scripts.git`
and linked `~/.local/bin/ballin` to `~/.ballin-scripts/bin/ballin`. NVM, backup,
completion setup and preference review were declined. Ownership selection remains
invocation-scoped; persistent direct update/removal behavior was not established.

Recording-wrapper status alone was not treated as a child-installer exit receipt.
Successful claims combine completion output with post-install inspection. An early
prepared-guest `--version` probe was invalid and supplies no passing evidence;
valid help output and package metadata are the relevant checks.

## Follow-ups and limits

- Clarify shared package onboarding's statement that shell startup files are
  unchanged: it refers to completion setup, not a preceding consented chooser
  profile change.
- Preserve upstream Homebrew analytics disclosure and opt-out guidance. Ballin's
  own analytics preferences do not configure Homebrew analytics.
- Keep administrator authentication in the interactive guest's secure entry flow;
  do not store credentials or change security policy to avoid a prompt.
- Reconcile the candidate with current product source before adoption. Native
  Intel, Rosetta, other macOS versions, complete maintenance, backup correctness,
  updater/removal, persistent owner selection and release provenance require
  separate coverage. Earlier prototype lifecycle results are not new tests here.
- No host migration, GitHub authentication, live backup, public tap, release or
  deployment occurred. No new installation policy follows from these results.
