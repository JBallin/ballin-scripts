# Homebrew-managed installation experiment

See [clean pre-release design](CLEAN-INSTALL-DESIGN.md) for the latest
recommendation after Jonathan clarified he is the only existing user and
is open to requiring Brew if beginner Quickstart remains simple. Neither
installation policy is decided. The
sections below describe the implemented experiment, not compatibility obligations.

Parked experimental source based on the version-aware-install branch at
`4ea163e9197833f83e4a87a9f0b4cfa56e69d8c9`, preserved for assessment in
[issue #17](https://github.com/JBallin/ballin-scripts/issues/17). Not a released
installation method, published tap, migration promise, or change to Quickstart.

The local generator installs source under a versioned keg and writes schema-2
`.ballin-package.json` metadata beside it. The receipt identifies the owning
formula, development version, caller-declared source revision, verified archive
checksum and stable command/completion paths. It does not claim a published
release. Schema-1 ownership remains readable for earlier experiments but cannot
perform initial onboarding. Preferences, analytics identity and backup cache live
under `~/.ballin`, separate from a Git installation's `~/.ballin-scripts`.
No existing preferences are imported automatically.

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

There is no clean single aggregate full-suite pass for this prototype. An earlier
full run was interrupted after failures later corrected and retested in focused
suites. The VM evidence does not cover interactive TTY onboarding, real backup or
authentication, full maintenance, first-time Homebrew provisioning, migration,
or an Intel/wider macOS matrix. Local experiment receipts remain separate from
this source checkpoint.

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
