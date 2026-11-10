# Homebrew-managed installation experiment

The [earlier dual-route design](CLEAN-INSTALL-DESIGN.md) records one alternative.
The current scoped prototype evaluates a Homebrew-first route after Jonathan
clarified he is the only existing user and is open to requiring Brew if beginner
Quickstart remains simple. Neither installation policy is decided. The
sections below describe the implemented experiment, not compatibility obligations.

Experimental source originally based on the version-aware-install branch at
`4ea163e9197833f83e4a87a9f0b4cfa56e69d8c9`, preserved for assessment in
[issue #17](https://github.com/JBallin/ballin-scripts/issues/17). The local runtime
prototype reconciles the preserved experiment `4dca8c4` with version-aware-install
`fbe14b4` (including unified-guided-setup `9609593`) and main `8bd2397`. Not a released
installation method, published tap, migration promise, or change to Quickstart.

The local generator installs source under a versioned keg and writes schema-2
`.ballin-package.json` metadata beside it. The receipt identifies the owning
formula, development version, caller-declared source revision, verified archive
checksum and stable command/completion paths. It does not claim a published
release. Schema-1 ownership remains readable for earlier experiments but cannot
perform initial onboarding. Preferences, analytics identity and backup cache live
under `~/.ballin`, separate from a Git installation's `~/.ballin-scripts`.
No existing preferences are imported automatically.
Package preference backups read the invoking installation's resolved configuration
file; direct-install discovery remains unchanged. Package installs do not export a coexisting Git installation's preferences,
and a missing package configuration does not fall back to the Git configuration.

## Initial setup and coexistence

After installing, run `ballin setup --initial`. It verifies that PATH selects this
package before writing state, prepares or updates configuration, asks separately
about optional GitHub backup and preference review, and preserves saved choices
on cancellation. Bare `ballin setup` remains preference-only. The formula never
runs interactive setup, authenticates, backs up data or edits shell profiles.

Initial setup prints guarded commands to source the package's Bash/Zsh completion
assets through stable paths. The configured assets use the package's Node runtime
and stable helper path; re-source after upgrades for updated definitions. Sourcing
Git assets afterward resets runtime selection to the Git workflow's ambient Node.

Brew owns command links. The Git installer's preflight and final link helper refuse
to replace a package-owned or unresolved package command. Package setup reports a
shadowing Git command without changing links or migrating its state. Choose one
active command explicitly; do not force-overwrite links. Package self-update and
uninstall name the exact owning formula. Brew removal retains `~/.ballin` state.

## Dependencies and release boundary

See [formula generation](FORMULA-GENERATION.md) for the local-only generator,
archive validation, Node dependency, and separate release/publication sequence.
Only supported Node is a runtime dependency; GitHub CLI and other maintenance
integrations remain optional. No npm runtime packages or transpilation are added.

The generated command selects the package's Node without adding its directory
to PATH. npm maintenance and inventory retain the caller's tool environment.
The package-owned update's backup child uses the application's Node and physical
script captured before integrations run. Direct installs retain PATH-based child
runtime selection. This isolates package runtime selection;
it does not change NVM failure handling or define a new npm selection policy.

Quickstart remains the current Git-based script. A future package handoff must
preserve its exact release/commit/branch selection guarantees rather than silently
installing the latest formula. Keeping Quickstart unchanged currently preserves
two installation systems; that is an evaluation choice, not a permanent policy.

## Verification and remaining work

The first disposable-VM experiments verified real package install, revision
upgrade, state retention, ownership guards, uninstall and running-keg update
ordering. Current initial-setup/coexistence/formula changes have isolated
regression tests and independent review. A generated-formula walkthrough on a
disposable macOS arm64 VM with Node 26 verified piped-input onboarding, package
upgrade, state retention, ownership guards, completion-helper continuity and
uninstall. That VM candidate predates a narrow CLI analytics identity-path
correction, which received focused regression checks and independent review.

A clean `npm test` run on November 10, 2026 passed at
`793a7ddc4da20a70d57e8e972988bb30073c2f1d` with Node 26.13.0: all 4,544 tests,
lint, both typechecks, release consistency and the unchanged coverage gates
completed with exit 0. Coverage was 99.59% for statements/lines, 96.82% for branches
and 100% for functions. All 30 separately invoked experimental tests also passed.
The subsequent ancestry merge `68719fc` includes the published stack's matching
test fixes at `fbe14b4`; its Git tree is identical to the tested `793a7dd` tree.
These runs used isolated fixtures, not live package or backup operations. The
earlier 4,407-test run at `680ce87` remains evidence for the original experiment,
not the current stack. Failed attempts remain separate receipts.
The later [November 9 chooser record](../../docs/installation-test-runs/2026-11-09-choice-candidate.md)
documents clean and prepared Homebrew installation from frozen source `919fb5b`.
It does not validate this current-stack runtime patch. Real backup/authentication,
full maintenance, migration and an Intel/wider macOS matrix remain outside this
prototype's validation. Preserve each VM attempt's own source and limits rather
than treating earlier receipts as a pass for the current candidate.

The runtime prototype has separate generated-launcher tests for missing or
incompatible ambient Node, competing caller/package npm, shell quoting and exit
status. Isolated real CLI tests run npm update and automatic backup through that
launcher, assert the caller's inventory reaches only a fake repository, and
verify cleanup follows backup while preferences and backup state remain outside
package code. These tests do not replace a new disposable-VM run of the final
candidate. Completion runtime-major changes, migration/schema policy, package
update controls and platform support remain separate decisions.

Before any release decision: verify the final candidate, consider package upgrade
configuration/schema and backup-scope communication, choose the Quickstart policy,
and implement/review the approved stable-release-to-tap publication flow. This
source checkpoint does not publish a package or tap and does not decide inclusion
in version 1.0.

## Running-keg update ordering

For package-owned invocations, `ballin update` captures ownership before Brew
work and sets `HOMEBREW_NO_INSTALL_CLEANUP=1` for its child environment. This keeps
the running keg and its runtime available through subsequent maintenance and
backup stages. Requested explicit cleanup runs last, and only if every preceding
stage succeeded. A failed or interrupted stage leaves older kegs for recovery;
normal failure status and existing child-interruption continuation are preserved.
A thrown invocation interruption does not run cleanup in a finally block.
Git installation ordering is unchanged. Post-cleanup work must not launch another
command from the retired keg.

Isolated fixtures simulate retirement of the running source directory during
cleanup, test backup-before-retirement, cleanup-disabled retention, and failure
statuses including 130/143. Real scoped Brew upgrade verification is recorded in
the external experiment receipt; no all-package host update is authorized.

## Update-notification recommendation

For the first package version, let Homebrew discover and install package updates.
Do not add a second background update service, fetch release metadata on ordinary
commands, or silently self-update Brew-owned files. `ballin self-update` should
continue to explain the exact Brew command. `ballin update` can upgrade packages
through its existing explicit Brew stage, with the running-keg protection above.
Homebrew does not autonomously upgrade Ballin merely because it was installed:
the user must run an upgrade or their chosen maintenance workflow. A later local,
cached “update available” hint is separate from self-updating and can be evaluated
if actual users need it; it is not necessary for the packaging experiment.

## Explicit owner-choice candidate

The [local chooser candidate](CHOICE-CANDIDATE.md) now offers an explicit official
Homebrew installation or the existing direct route without invoking Brew. It is
isolated under this experiment and uses a frozen unpublished source transport for
disposable guests. Public Quickstart does not invoke it. Its invocation-scoped
owner flag, separate prototype state paths, prepared-Git transport prerequisite
and unverified live matrix cells are deliberate limitations, not shipped policy.
