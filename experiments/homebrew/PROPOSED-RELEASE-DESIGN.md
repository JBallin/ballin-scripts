# Proposed Homebrew release design

This is the current technical proposal for review, not an adoption or publication
decision. The public Quickstart remains the direct installer. The earlier
[dual-install design](CLEAN-INSTALL-DESIGN.md) is an alternative record, not the
implementation plan for this prototype.

## Decisions made for this proposal

- Homebrew owns package code, dependencies, command links, upgrades and removal.
  Ballin owns configuration and operational state under `~/.ballin`.
- Keep that existing package layout. Do not add an XDG redesign or move a direct
  installation's state as part of packaging. Only one command owner should be
  active; conflicting owners require an explicit switch rather than forced links.
- Keep the tested Node major from `.nvmrc`, currently 26, as `node@MAJOR`.
  Homebrew supplies patch/minor updates. The formula checks the selected major and
  package minimum; formula availability must be checked for each release candidate.
- The launcher selects package Node without changing caller PATH. npm maintenance
  and inventory still use the caller's npm. No extra npm runtime packages, NVM
  requirement, background updater or ordinary-command network check is introduced.
- Keep Git self-update behavior separate. `update.selfUpdate` controls the Git
  self-update stage; it does not exclude Ballin from Homebrew upgrades.
  `ballin self-update` on a package explains its owning `brew upgrade` command.
- Keep configuration values, unknown fields, analytics identity and backup
  comparison state across package upgrade/removal. `.backup-cache` is not a
  disposable download cache: it affects backup reconciliation.
- Present-schema upgrades need no migration. New settings require safe read-time
  defaults and must preserve saved values; setup can materialize missing options.
  An incompatible future schema change must have an explicit migration and recovery
  design before that release. Do not build a migration framework for hypothetical users.

## First installation

Installing the formula installs code and its runtime only. It does not run setup,
authenticate, capture a backup or modify shell profiles. `ballin setup --initial`
checks command ownership, prepares external configuration, then offers optional
backup and preference review. Repeating setup preserves existing choices.

For a Homebrew-first product, Quickstart would remain the guided entry point:
explain the selected owner, offer the official Brew bootstrap when missing, install
the selected package, verify it, then run initial setup. Administrator and Apple
developer-tool prompts remain upstream-owned. The existing experimental chooser
proves this clean Apple Silicon flow, but is still a development-source transport.

## Stable release identity and candidate preparation

The implemented experimental collector reads an exact published stable GitHub tag,
requires a positive release ID and published/non-draft/non-prerelease metadata,
peels the tag to its commit, and downloads the archive from that exact upstream
commit. It validates archive structure, package version, installer protocol and
runtime requirements and an explicit `ballin.packageSchema: 3` capability, then
checks that the release ID and tag target did not move. Installer protocol 2 alone
is insufficient: earlier archives cannot read stable package markers.

```
node experiments/homebrew/release-provenance.cjs \
  vX.Y.Z /absolute/new/directory owner/tap/ballin-experiment
```

This writes source bytes, a provenance report and an experimental Ruby formula.
It does not install, publish, create a tap/tag/release, or change public Quickstart.
The output directory must be new; interrupted output remains for inspection.
Tests supply a fake transport; no real release or download is claimed by those tests.

Stable generation consumes the collector's in-process verified result, derives the
commit-addressed URL and checksum itself, and rejects identity/runtime overrides.
Reopening a JSON report cannot turn unrelated bytes into a verified release.
The installed schema-3 receipt records release tag/ID, source SHA, archive hash,
package version, runtime contract, owning formula and stable command paths.
Schema 2 remains development-only; schema 1 retains legacy limitations.
This is a packaging-time provenance record, not a signature or installed-file audit.

## Exact selection and the remaining public handoff

The implemented comparison gate accepts only the exact resolved release tag, ID,
SHA, version, runtime and owning formula. It rejects branch/SHA selectors and
unavailable historical releases instead of installing latest silently.

Proposed version-one package support is the current published stable formula.
Explicit development and unavailable historical selectors must fail with a clear
route choice; the public interface must not silently change their meaning. Whether
that choice retains a supported direct installer is a product decision below.

The comparison gate is not yet a public bootstrap. Before wiring it into
Quickstart, bind the recipe being checked to the recipe actually installed, disable
implicit tap advancement for that operation, verify the resulting installed marker,
and only then onboard. Merely checking tap metadata before an unconstrained
`brew install` is insufficient: the recipe can change between those operations.
The existing isolated local-tap pattern is appropriate for fixture/VM validation;
production tap delivery must preserve this same contract. Do not claim this final
handoff is implemented by the pure comparison helper.

## Updates, completions and backup scope

A package-owned update captures its physical code and Node before Homebrew runs,
disables automatic cleanup in its children, and runs explicit cleanup only after
all enabled stages succeed. Failure retains old kegs. There must be no new child
loaded from a retired keg after cleanup. The separate real VM test established this
for same-source package revisions with a fixed Node runtime, not every dependency
or schema transition.

Dynamic completions now use a private runtime trampoline through Ballin's stable
opt path. Both helper and runtime follow the active package even in an already-open
shell after the old package/runtime is removed. Changed static command definitions
still require re-sourcing completion assets.

Full package backups compare the bundled source catalog with the last locally
notified catalog. A first, changed or unavailable comparison displays the current
source guidance before collection. Sensitive-source opt-in retains its existing
current/future-source meaning; there is no new consent requirement. Identical
catalogs stay quiet. The small `~/.ballin/.backup-scope-notice` record is notification
bookkeeping, not acknowledgment, consent, cached backup content or a remote snapshot.
A failed write warns but does not change backup results. Checking at backup time
also covers upgrades performed directly through Brew.

## Source, Claude backup and release sequencing

The current integration preserves Homebrew checkpoint `53a9b56` and includes
version-aware-install `f3edbb3`, which already contains guided setup `171db47`
and main `8bd2397`. It brings in the newer setup handling, NVM diagnostics,
coverage cases and focused native macOS workflow. [Validation results](README.md#verification-and-remaining-work)
belong to their named source checkpoint; publication does not imply adoption.

The independent Claude preference source is [PR #678](https://github.com/JBallin/ballin-scripts/pull/678)
at `b1caad6`, targeting main. It is not copied into this worktree. The formula
already installs the whole commands directory and its JSON catalog.
When that feature is integrated, preserve its filtered collector,
sensitive-source policy, catalog and completions, then verify package capture and
scope-change notice against the combined tree.

The release path remains explicit: approve the source design; reconcile and review
the intended source stack; validate the exact merged source; approve/publish its
version, tag and notes; collect verified release bytes and review the formula;
separately approve tap publication; validate fresh install, upgrade and recovery of
that published package. No custom artifact hosting service is needed.

## Product decisions still required

- Is Brew required, preferred with a supported direct alternative, or optional?
- Does the supported audience accept current official Apple Silicon/macOS support?
  The current official new Brew installer rejects Intel; existing Intel Brew is
  not evidence of supported new installation.
- Is current stable sufficient for the package channel, with explicit rejection
  of unavailable historical/development selections?

Tap identity and the public command spelling can be proposed during adoption, but
creating or publishing them remains separate authorization. These product choices
do not prevent review of the implemented technical contracts.
