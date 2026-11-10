# Releasing Ballin

*Maintainer guide to preparing and approving a release.*

GitHub tags and published GitHub Releases identify releases and their notes.
The private package's `package.json.version` is the canonical release version;
`package.json.ballin.installerProtocol` records bootstrap compatibility. Neither
field proves that a checkout is a published release. Release identity still
requires the verified published GitHub Release and its exact tag and commit.

Use this guide for the product release, then follow the
[site/gallery route](website.md#start-to-finish-workflow) if publishing examples.
Docs-only changes reuse the pin; an initial gallery and a selected refresh have
separate capture/packaging paths. Reuse recorded approvals and bring the maintainer
in for missing authority, publication decisions or access/policy changes.

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

Stable is the permanent installer default. Before the first release, the public
commands temporarily use the main script URL and explicitly set
`BALLIN_UPDATE_TRACK=main` for Bash. Development installations must opt into main;
there is no stable-to-main fallback. Version-only release preparation replaces
those temporary commands with the intended versioned URL and removes the main
override. That URL is not usable until the approved release is published. Running
scripts refuse missing or unpublished releases before setup mutations.

Submit the preparation diff through a separately authorized PR and normal review.
After merging, validate the exact merged SHA in a disposable macOS VM under
[Installation testing](installation-testing.md). **Before publication**, use the
entrypoint from that merged commit and select the same full `--sha`; see
[revision selectors](installation.md#selecting-a-revision) and the
[exact-candidate entrypoint recipe](installation-testing.md#prelaunch-entrypoint-recovery).
The prepared README's versioned stable URL points at an unpublished release and
is not the pre-publication test command. Do not substitute a reviewed pre-merge
head, and do not count an explicit-SHA install as proof of stable selection.

## Analytics coordination

The matching client and Worker accept numeric release versions, `development`,
and `unknown` in the existing text field. No data reset or D1 migration is needed.
Relevant changes merged to main trigger the existing production Worker deployment
workflow. Account for that deployment when approving a merge; verify the matching
Worker before normal delivery of the client, including while development installs explicitly track main.
A code review or release-preparation command does not itself authorize deployment.

## Approve and publish

Present the proposed version, exact tested merged SHA, and complete release notes
for maintainer review. Obtain explicit approval of that specific publication
request before creating a tag or GitHub Release. A thumbs-up on that request is approval;
approval to implement or merge is not. A changed SHA, version, or notes requires
an updated approval.

If later gallery attachment is planned, [verify release mutability under the
effective policy](website.md#attach-to-the-actual-product-release) before publishing;
if it cannot remain mutable, stop for a reviewed resolution.

Immediately before publication, recheck the approved SHA, intended tag, notes,
and existing GitHub state with ordinary Git and `gh` commands. Refuse conflicting
existing tags/releases. Never force-move a tag or overwrite a conflicting release.
Create the approved tag at the approved SHA and publish the stable GitHub Release
using normal `git`/`gh` operations. No custom publishing framework is required.

Verify the remote tag resolves to the approved commit, the release is published
and stable, and the notes match approval. If an operation fails partially or its
outcome is uncertain, inspect existing state before retrying. **After publication**,
verify a fresh stable/versioned install and an existing stable-track installation's
self-update select the published release and preserve local state. An explicit-SHA
candidate installation remains commit-selected; it does not silently become a
stable-track installation. Test a track change separately with its confirmation,
using the documented selectors. GitHub Releases are the release-note history;
do not maintain a duplicate changelog.

For gallery publication, continue with the
[ordered site/gallery route](website.md#start-to-finish-workflow).
The [tooling recipes](../tools/output-gallery/README.md#package-approved-examples)
own generation, selection, ZIP naming, replacement and offline candidate review;
[site maintenance](website.md#attach-to-the-actual-product-release) owns release
attachment, real pin verification and Pages activation. Whenever the canonical
Update example changes, exporting and updating the README's matching embedded
text from that same bundle is a required dependency, not later cleanup. Coordinate
it with pin activation; first image links wait for verified public delivery.
For a partial gallery refresh, put the
[replaced/retained summary and local-review results](../tools/output-gallery/README.md#review-the-refresh-summary)
in the review handoff so reviewers can go directly to the replaced examples.

Before a merge, account for automatic Pages and Worker deployment triggers, not
only manual release/deploy commands. Record completed steps, tested SHA, approved
version/notes, release/asset identity and hashes, verification and next blocked
action. On resume, recheck external state before retrying. Preserve a known-good
pin/deployment and use the [site recovery procedure](website.md#deploy-and-recover)
for gallery failures; a gallery refresh is not a new release or full manual retest
requirement for every product change.
