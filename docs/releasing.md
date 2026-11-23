# Releasing Ballin

*Maintainer guide to preparing and approving a release.*

GitHub tags and published GitHub Releases identify releases and their notes.
The private package's `package.json.version` is the canonical release version;
`package.json.ballin.installerProtocol` records bootstrap compatibility. Neither
field proves that a checkout is a published release. Release identity still
requires the verified published GitHub Release and its exact tag and commit.

## Prepare

Run `npm run release:prepare -- 1.0.0` for the intended version. The command updates
package and lockfile metadata, embedded bootstrap blocks in both entrypoints,
and known install URLs in README, Quickstart, and installation guidance. It
produces an ordinary Git diff and never creates tags, publishes, merges, or
deploys. Run `npm run release:check` and review the complete diff and all documented
installation commands. The minimum Node version derives only from `package.json`
engines. Bootstrap protocol 2 supports only revisions carrying compatible package
metadata; older revisions are unsupported. For prelaunch entrypoint recovery, see
[Installation testing](installation-testing.md#prelaunch-entrypoint-recovery).

Stable is the permanent installer default. Development installations must opt
into main explicitly; there is no stable-to-main fallback. Running scripts refuse
missing or unpublished releases before setup mutations.

Submit the preparation diff through a separately authorized PR and normal review.
After merging, validate the exact merged SHA, including disposable macOS VM
installation as described in [Installation testing](installation-testing.md).
Do not substitute a reviewed pre-merge PR head for the merged candidate.

## Analytics coordination

The matching client and Worker accept numeric release versions, `development`,
and `unknown` in the existing text field. No data reset or D1 migration is needed.
Relevant changes merged to main trigger the existing production Worker deployment
workflow. Account for that deployment when approving a merge; verify the matching
Worker before normal delivery of the client, including while development installs explicitly track main.
A code review or release-preparation command does not itself authorize deployment.

## Approve and publish

Present the proposed version, exact tested merged SHA, and complete release notes
in chat. Obtain explicit approval of that specific publication request before
creating a tag or GitHub Release. A thumbs-up on that request is approval;
approval to implement or merge is not. A changed SHA, version, or notes requires
an updated approval.

Immediately before publication, recheck the approved SHA, intended tag, notes,
and existing GitHub state with ordinary Git and `gh` commands. Refuse conflicting
existing tags/releases. Never force-move a tag or overwrite a conflicting release.
Create the approved tag at the approved SHA and publish the stable GitHub Release
using normal `git`/`gh` operations. No custom publishing framework is required.

Verify the remote tag resolves to the approved commit, the release is published
and stable, and the notes match approval. If an operation fails partially or its
outcome is uncertain, inspect existing state before retrying. Finally verify a
fresh versioned install and existing-install self-update select the published
release and preserve local state. GitHub Releases are the release-note history;
do not maintain a duplicate changelog.

## Temporary first-release rollout

Retire this section after the first-release transition is verified in #659.
Before the first release, public commands use the main entrypoint and explicitly
set `BALLIN_UPDATE_TRACK=main` for Bash. Version-only release preparation replaces
those commands with the intended versioned URL and removes the override. That
URL is not usable until the approved release is published.

Until production documentation is published and its destinations are verified,
installer, Quickstart and CLI links use public GitHub docs. The protocol-1
[recovery instructions](https://github.com/JBallin/ballin-scripts/blob/d5f6b1bc13bd6b3c6f2ea1e904dc00dd375bf3d3/docs/installation-testing.md#prelaunch-entrypoint-recovery)
and [manual NVM activation](https://github.com/JBallin/ballin-scripts/blob/d5f6b1bc13bd6b3c6f2ea1e904dc00dd375bf3d3/docs/installation.md#manual-nvm-activation)
use an immutable published candidate because main does not yet contain those
sections. Select a separately reviewed full candidate SHA when following the
recovery procedure; the documentation revision is not an installation selection.
Keep this fallback reachable for old entrypoints after the rollout notes retire.

The branded documentation cutover is a separate downstream site change (#671),
after publication and verification of every linked page and anchor. It is not a
prerequisite for merging this installer change. Recheck help, plain output and
terminal hyperlinks at cutover, and refresh affected #669 gallery URL expectations
and reviewed formatter profiles before regenerating evidence. Historical captures
retain their original revisions and destinations.
