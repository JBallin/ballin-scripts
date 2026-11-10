# Earlier dual-install alternative

Status: earlier alternative, superseded as the current proposal by
[Proposed Homebrew release design](PROPOSED-RELEASE-DESIGN.md). Retained to explain
the dual-route tradeoff, not an accepted installation policy. Jonathan is
the only existing user and is open to requiring Homebrew. His priority is a simple
one-script experience for people who do not already have it. Mandatory non-Brew
support and mandatory Brew are both undecided; earlier statements treating either
as settled are superseded. His actual installation/data remain untouched.

## Recommendation after comparing the actual bootstrap paths

Prefer Brew for ordinary package installation, but retain the direct Quickstart
route for version 1.0 rather than make Brew mandatory. This is based on existing
code, not a compatibility obligation: the current Quickstart already supports
consented non-Brew prerequisite setup. Keeping that route preserves a functioning
beginner experience without adding a new Homebrew bootstrap requirement. Share
onboarding and state, and keep two small, explicit ownership backends.

A Brew requirement can still offer a single copy/pasted command: Quickstart would
explain/install Homebrew if absent, establish shell access, install Ballin and
its package dependencies, then onboard. It is not a zero-cost or zero-prompt
flow. Initial provisioning can need elevated permission, download/install time,
platform checks and recovery. Brew owns later upgrades and dependency management,
which reduces Ballin's long-term custom installer/updater surface. If this route
proves materially simpler in a clean-machine comparison, requiring Brew remains
a reasonable later decision; do not decide from command count alone.

The independent route retains custom prerequisite/revision/updater code and a
second lifecycle test matrix, but avoids imposing another package manager. Some
maintenance features are unavailable without Brew; backups and other supported
integrations still have value. Neither backend should silently take over the
other's links or state. No migration engine is required for hypothetical users.

Evidence: current `docs/installation.md` and `quickstart.sh` offer official
versioned NVM installation when suitable Brew is absent, Node setup, Git/Apple
command-line-tool setup and optional GitHub CLI setup. Current `commands/update.ts`
already conditionally runs its Brew stage. The completed package VM tests began
with Brew present; they do not validate first-time Homebrew bootstrap or compare
novice onboarding duration/failure recovery.

Homebrew's official installation guide documents initial provisioning, platform
support and shell setup: https://docs.brew.sh/Installation . These are additional
bootstrap responsibilities, not reasons to describe Brew as unsafe or unusable.

## Two supported installation owners, shared product behavior

For the recommended dual-route design, support these persistent installations:

- **Homebrew:** immutable packaged code and supported Node dependency in Brew's
  managed locations; Brew owns command links, upgrades and code removal.
- **Direct, without Homebrew:** a managed Git checkout at
  `$XDG_DATA_HOME/ballin/source` (default `~/.local/share/ballin/source`), with a
  launcher at `~/.local/bin/ballin`. The direct installer owns that checkout and
  launcher. Use the existing reviewed revision/provenance/dirty-check/confirmation
  machinery after removing its assumptions about `~/.ballin-scripts`.

Recommend the direct Git backend initially rather than inventing an additional
archive extraction, transactional version-switch and rollback system. This uses
existing tested updater logic, while making code separate from writable state.
A future immutable direct-release backend is optional, not required for Brew or
non-Brew support. A direct installer must never write to Brew's Cellar or opt tree.

Quickstart remains a convenience entry point, not a third installation owner.
It must offer a complete direct path without installing or invoking Homebrew.
An explicitly selected Brew route may call the package installer; both routes
then use the same onboarding code. Show the selected owner/location before effects.
Do not silently choose Brew merely because it happens to be installed. Exact
release/commit/branch selection is implementable on the direct route; reject
unsupported Brew selectors clearly rather than silently selecting latest.

## Prerequisites without forcing Brew

The direct route needs supported Node and Git for installation/self-update. A
user-provided Node/Git from any supported source should work; validate versions and
report missing prerequisites. Do not require NVM, npm runtime packages, GitHub CLI
or Brew just to execute the core CLI. On macOS Git may require Apple's command-line
tools; detecting this must not silently accept terms or start an installation.

Preserve the current non-Brew Quickstart prerequisite capability rather than
replace it with manual-only instructions. It already offers consented NVM/Node
and missing-tool setup. Adapt and retest those paths against the new code/state
layout; retain existing confirmation, provenance, cancellation and resume rules.
Manual guidance remains the fallback for unsupported or failed provisioning, not
the proposed primary beginner path. Do not invent a second Node installer.

Maintenance integrations remain optional and capability-based. Without Brew,
`ballin update` should report that Brew-managed package maintenance is unavailable,
then perform only enabled, available integrations. It must not install Brew as an
implicit side effect. Backup discovery should likewise skip unavailable tools.

## Separate code, configuration and working data

Use one central resolver with CLI-standard XDG locations and documented overrides:

- `$XDG_CONFIG_HOME/ballin` (default `~/.config/ballin`): editable configuration.
- `$XDG_STATE_HOME/ballin` (default `~/.local/state/ballin`): persistent local
  identity and operational state, including opt-in analytics identity if enabled.
- `$XDG_CACHE_HOME/ballin` (default `~/.cache/ballin`): reconstructible backup cache
  and disposable working data. Confirm recoverability before classifying as cache.
- `$XDG_DATA_HOME/ballin/source`: direct-managed code only; no personal configuration.
- Brew Cellar/opt: Brew-managed code, provenance and completion assets.

These paths are proposed; the current experiment still uses combined `~/.ballin`
state for packages. Validate overrides and permissions before writes. Installation
receipt and code identity must identify owner and location independently of config.
Onboarding creates needed state without implicit login or backup. Uninstall removes
only its owner's code/launcher and retains configuration/state by default.

Normal direct and Brew installs may use the same stable user configuration schema,
but only one command is selected at a time. Changing owner is an explicit switch,
not a link overwrite or automatic migration. Reject competing links and unsupported
state schemas before writes. Developers and parallel tests use separate profiles.
Never import Jonathan's current checkout/config or the experiment's state silently.

## Update ownership

`ballin self-update` dispatches by verified installation receipt:

- Direct-managed checkout: use the reviewed direct updater, preserving dirty-work,
  revision-selection, provenance and confirmation safeguards. Update only this code
  checkout, not user state or a contributor clone. Do not infer ownership from PATH
  or an environment variable alone.
- Brew package: explain the exact `brew upgrade <formula>` command. Never Git-pull
  or rewrite a keg. Explicit `ballin update` may upgrade Ballin within its existing
  Brew stage, retaining the tested running-keg and deferred-cleanup protections.
- Contributor checkout: explain updating the branch explicitly with Git. Never
  automatically reset, pull or replace the developer's work.

No separate background version notifier initially. Notification and self-update
are distinct: direct users have an explicit self-update/maintenance workflow and
Brew users have Brew's upgrade workflow. Ordinary commands should not fetch version
metadata. A later hint can be designed without silently changing ownership or code.
Installing Brew does not automatically schedule upgrades.

## Contributors and ongoing maintainership

Homebrew's contributor guide edits the Git repository reported by
`brew --repository` for changes to Brew itself, while formula work edits a tap.
That differs from editing formula-installed Cellar code. Ballin contributors use
upstream source clones, never a package keg or the direct-managed runtime checkout.
Source: https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request

1. Clone/fork Ballin anywhere, for example `~/src/ballin-scripts`; create a branch
   or per-task worktree. Use supported Node and `npm ci` for development tests.
2. Run explicit `./bin/ballin`, leaving the installed `ballin` command unchanged.
3. Give each worktree a private data root; set XDG_CONFIG_HOME, XDG_STATE_HOME and
   XDG_CACHE_HOME per invocation and disable analytics. No automatic copying of
   personal configuration or credentials. A development wrapper can simplify this.
4. Run lint/typecheck and focused fixture tests. Use disposable VMs for real install,
   update, backup, uninstall and shell-profile checks. Config isolation is not a
   filesystem/network/authentication sandbox.
5. Test frozen direct and formula candidates in separate clean VM cases. A source
   PR need not modify the tap; recipe changes have separate scoped package tests.
6. Push the source branch and open a Ballin PR. No contributor needs a Brew-installed
   Ballin, a private tap, or the maintainer's production installation.

Example after the proposed path resolver is implemented:

```sh
DEV_DATA="$HOME/.local/share/ballin-dev/my-feature"
XDG_CONFIG_HOME="$DEV_DATA/config" \
XDG_STATE_HOME="$DEV_DATA/state" \
XDG_CACHE_HOME="$DEV_DATA/cache" \
BALLIN_NO_ANALYTICS=1 ./bin/ballin help
```

Do not export XDG overrides globally, because other tools use them too. A developer
source checkout must be explicitly identified, so the direct updater cannot mistake
it for installer-owned code.

## Scope and tradeoffs

Two ownership backends entail more installer/update tests than Brew-only, but preserve
the existing non-Brew use case under this recommendation. Share path resolution, onboarding, configuration,
CLI behavior and most tests; keep owner-specific installation/update/remove code
small and explicit. Moving direct code does not require preserving an obsolete
pre-release path or implementing a general migration engine.

Next implementation steps:

1. Implement the common path/owner resolver and audit every write and backup scope.
2. Adapt the existing direct installer/updater to its managed code root and stable
   launcher, with safeguards protecting arbitrary contributor directories.
3. Unify onboarding across direct, Brew and Quickstart; validate direct prerequisites
   with Brew entirely absent. If comparing a Brew-required alternative, also test
   first-time Homebrew provisioning, cancellation and resume before deciding.
   Update help/selector semantics explicitly.
4. Implement verified stable-release-to-formula generation and review. Publication
   and release inclusion remain separate decisions requiring authorization.
5. Run clean direct/Brew install, cancellation, update, state retention, owner
   conflict, contributor isolation and uninstall matrices in disposable VMs, then
   the final aggregate regression gate on frozen source.
6. Propose Jonathan's manual switch with inventory/recovery steps. Do not move,
   delete, update or migrate his existing host installation without approval.

This follow-up changes assessment only. The tested prototype proves substantial
Brew mechanics, not this dual-layout redesign, non-Brew Quickstart automation or
version-1.0 readiness.
