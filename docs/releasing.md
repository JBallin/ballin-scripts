# Releasing Ballin

*Maintainer guide to preparing and approving a release.*

GitHub tags and published GitHub Releases identify releases and their notes.
The private npm package has no release version. `release.json` records preparation
intent; it is not proof that a checkout is a published release.

## Prepare

Run `npm run prepare-release -- 1.0.0 stable` for the intended version and policy.
The command updates shared metadata, the data-only installer contract, embedded
bootstrap blocks in both entrypoints, and known install URLs in README,
Quickstart, and installation guidance. It produces an ordinary Git diff and
never creates tags, publishes, merges, or deploys. Run `npm run check:release`
and review the complete diff and all documented installation commands. The
minimum Node version derives from `package.json` engines. Bootstrap protocol 1
supports only revisions carrying its contract; older revisions are unsupported.

The version-support implementation retains `main` as its deliberate temporary
default. Stable activation is a separate reviewed change. Before the first tag
exists, a versioned raw URL fails in curl before any script runs. Running scripts
also refuse missing/unpublished releases before setup mutations. Neither case
falls back to main.

Submit the preparation diff through a separately authorized PR and normal review.
After merging, validate the exact merged SHA, including disposable macOS VM
installation as described in [Installation testing](installation-testing.md).
Do not substitute a reviewed pre-merge PR head for the merged candidate.

## Analytics coordination

The matching client and Worker accept numeric release versions, `development`,
and `unknown` in the existing text field. No data reset or D1 migration is needed.
Relevant changes merged to main trigger the existing production Worker deployment
workflow. Account for that deployment when approving a merge; verify the matching
Worker before normal delivery of the client, especially while main is the default.
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
