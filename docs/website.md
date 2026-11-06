# Documentation site and public gallery

*Maintainer guide to building complete documentation snapshots and deliberately activating approved gallery assets.*

The website renders the root README and canonical guides in this repository.
GitHub Releases remain the published release-note history. Product release
preparation belongs to [Releasing Ballin](releasing.md); VM validation belongs to
[Installation testing](installation-testing.md). The site does not change the
installer's stable release selection or require gallery regeneration per release.

## Build approach

The bounded Python and markdown-it builder reuses the project's existing
Node/Python toolchain and keeps the tested documentation output together with
the separate bundle-safety pipeline. Jekyll is also a valid option. Keeping this
builder means maintaining its dependencies, Markdown rendering, link rewriting
and heading compatibility as the documentation evolves.

## Build locally

Use Node.js from `.nvmrc` and Python 3.9 or newer. From the repository root:

```sh
npm ci --ignore-scripts
npm ci --prefix site --ignore-scripts
python3 tools/site/test_site.py
python3 tools/site/site.py build --output .site-output/review/root
python3 tools/site/preview.py --site .site-output/review/root
```

Open `http://127.0.0.1:8000/index.html`. The preview server binds
only to loopback and serves only the selected complete snapshot, not its parent
or other ignored evidence. `--port 0` chooses a free port and prints its URL/PID.
The preview reads its base from the snapshot; `--base` overrides it. Older
snapshots without hosting metadata retain the `/ballin-scripts` preview default.
Stop with Control-C, or send TERM to that printed PID. Restart the same command
to serve that snapshot again.

These are one-time builds: there is no file watcher or browser live reload.
The server reads the selected output files on each request. If a local review
adapter changes those files in place, a browser reload or fresh request can show
the changes without restarting the server; an already open page is not pushed
updates. Browser caching can affect when an asset is refreshed. Editing README,
docs or tooling source alone does not update generated pages. Rebuild into a new
directory and serve that output to inspect source changes.
The root package has no site build/serve wrapper; `npm --prefix site test` runs
the site checks after both dependency installs. Existing output is refused.
Failed builds retain a `.site-build-*`
directory beside the chosen output for diagnosis; successful snapshots replace
nothing. Never point build or packaging output at raw captures or source inputs.
`.site-output/`, `site/node_modules/` and Python caches are ignored.

`site/bundle.json` explicitly starts in `bootstrap` mode. This builds useful docs
without a gallery navigation item, gallery page or placeholder image links.
Changing it to `release` mode activates one approved bundle. Missing, altered or
unavailable pinned assets stop the build; they never fall back to bootstrap.
The previous live deployment remains available when assembly or validation fails.

For integrated offline review, pass `--pin /path/to/reviewed-pin.json` and
`--bundle /path/to/matching.zip` to `build`, then serve that selected output.
The ZIP still must match its pin. Synthetic review bundles must remain labeled
as synthetic; an offline review does not establish a live approved product
Release. The committed bootstrap configuration does not require any bundle.

The build checks local pages, project base paths, fragments and image alt text.
It supports repository-relative Markdown/asset links and section fragments;
root-relative repository links and encoded path separators are refused with an
actionable error. Encoded filename delimiters remain path data. Heading IDs and
rendering are tested against the canonical docs, rather than promising universal
GitHub rendering parity. Non-documentation source links lead to
the exact site source commit on GitHub. The build emits a sitemap and canonical
URLs using the configured canonical origin and base.

## Hosting configuration

`site/deployment.json` defines the intended canonical origin and base for the
Actions build: `https://getballin.com` and an empty base for root hosting. This
controls navigation, gallery/image/text paths, canonical URLs, sitemap and social
metadata together. Source links continue to point to the exact GitHub revision.
The existing branded PNG is copied to `docs/assets/brand/social-preview.png` and
used in static Open Graph and Twitter large-card metadata with absolute URLs.

For a GitHub project-site snapshot, override both values explicitly:

```sh
python3 tools/site/site.py build --output .site-output/review/project \
  --origin https://jballin.github.io --base /ballin-scripts
python3 tools/site/preview.py --site .site-output/review/project
```

That preview prints `http://127.0.0.1:8000/ballin-scripts/index.html`. To select a
different durable deployment target, edit the same configuration, or supply
`--config /path/to/config.json` with exactly `origin` and `base`. Overrides affect
one build only. Local serving stays loopback-only while canonical/share URLs
remain those of the intended public target.

For an Actions deployment, configure the same custom domain separately in
GitHub Pages settings and maintain its DNS and HTTPS configuration. A source or
artifact `CNAME` does not configure this: [GitHub ignores CNAME files for custom
Actions workflows](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
When changing hosting, verify the configured origin/base against deployed pages,
assets, gallery viewers, transcripts, fragments, sitemap and social metadata.
Check certificate/redirect behavior and inspect sharing-platform previews after
publication; local metadata checks cannot establish crawler behavior.

## Website QA

Build a fresh complete snapshot and open the URL printed by the loopback preview
helper in an authorized local browser. Inspect the rendered page and interactions;
an HTTP response or source inspection alone does not establish visual quality.

- Compare home, gallery, documentation index and a user guide at ordinary desktop,
  wide and narrow widths (for example 1280, 1600 and 390 pixels). Keep the shared
  navigation order Documentation, Gallery, GitHub; bootstrap intentionally omits
  Gallery. Check aligned page widths, readable text and no page-wide overflow.
- Complete a docs → gallery → example → matching text → download → return journey.
  Follow the intro's Gallery link when present, the README example and
  Acknowledgments links. Repeat navigation and browser Back/Forward. Capture
  disclaimers belong with capture evidence, not unrelated prose pages.
- Open an example and a continuation page. Check the complete fitted image and
  native-resolution scrolling/arrow keys. Narrow images need readable transcript
  and original-image alternatives; never fix clipping by cropping evidence.
- Activate matching-text links with the target collapsed, expanded and collapsed
  again at the same fragment. Each click should open its ancestors and align the
  target after layout settles. Check long transcript lines and Copy spacing.
- Test keyboard Copy and its visible result without reading pre-existing clipboard
  contents. Verify the Download target and, when permitted, the saved transcript.
  A timeout or permission prompt is not successful completion; inspect an uncertain
  outcome before retrying. Keep browser permissions and unrelated files unchanged.
- Check command-before-output context and concise actual/staged, historical and
  incomplete labels. Keep technical provenance accessible without burying examples.
  Use the [CLI-output review workflow](../tools/output-gallery/README.md#review-command-line-output)
  to establish source fidelity separately from presentation quality.

Run `python3 tools/site/test_site.py` and relevant lint/typechecks after source
changes; build both the configured root target and explicit project-path mode.
Check keyboard reachability and visible focus across navigation, disclosures and
controls, and sample text/link contrast. Inspect browser errors and failed resource
requests; scroll long examples and confirm images load without shifting controls.
Use comparable before/after views at the same widths when changing layout. Record
the source revision/dirty state, snapshot and passed/failed/blocked checks; distinguish
observed bugs from unverified causes. Keep local screenshots/evidence ignored and private.

## Curate a bundle

Generate review evidence deliberately on the local Mac using the
[output-gallery tooling](../tools/output-gallery/README.md): Node.js 26, Python 3,
Swift/AppKit and, for actual recordings, separately authorized disposable Tart
VM work. No capture or rendering runs in Pages CI. Keep private authentication
outside recordings. Review meaningful prompts, answers, outcomes, redactions,
wrapping and labels in both PNGs and matching text. Current-stack review captures
are not the initial stable-release installation examples: those follow the
approved stable release and verified real runs described in the installation guide.

Select only files separately approved for public distribution. Review approval of
a local capture alone is not permission to publish it. Put a selection JSON in
the ignored `.site-output/` directory, for example:

```json
{
  "schema": 1,
  "entries": [{
    "scenario": "staged-09",
    "id": "update",
    "title": "Update and recovery",
    "edits": "Source-informed staged output; no live execution.",
    "approvedForPublication": false,
    "readmeUpdate": true
  }]
}
```

Set `approvedForPublication` to `true` only after approval of the actual selected
images, display text and public title/disclosure. `scenario` selects a generated
entry; `id` defines its stable public path. Each entry inherits its source commit,
category and `actual-vm`/`staged` classification. `edits` is an intentionally public
disclosure of substantive edits or omissions; review it alongside the output.
Choose a single canonical Update entry with `readmeUpdate` when ready to coordinate
the README example. Do not relabel staged output as actual execution.

```sh
python3 tools/site/site.py pack \
  --gallery .output-gallery/FULL_SOURCE_SHA \
  --selection .site-output/selection.json \
  --output .site-output/ballin-gallery-assets-v1.0.0.zip
python3 tools/site/site.py inspect .site-output/ballin-gallery-assets-v1.0.0.zip
```

Packaging verifies generation hashes and the renderer's exact logical-text match.
It produces a deterministic ZIP and reports its SHA-256, byte size and entry count.
It removes PNG EXIF, text and time metadata without changing encoded pixels or
color chunks. Bundle hashes describe those publication bytes, after source hashes
have verified the original generated files.
The ZIP contains only selected PNGs, matching UTF-8 text and a minimal public
manifest with per-file hashes and intentionally public provenance. It excludes raw
ANSI, command/answer/environment data, capture manifests, private input paths,
source snapshots, renderer reports and generation tools. Never upload the whole
gallery directory. Human review is still necessary: hash agreement proves byte
identity, not absence of secrets or faithful execution. The importer cannot prove
that a declared actual run happened.

Retain useful PNGs and matching text with source revision and actual/staged labels
for affected-flow PR review. Use a verified supported attachment method or another
separately authorized evidence handoff. Do not require captures for
unrelated engineering changes. Generation cost and recurring refresh scope remain
unmeasured rather than an every-release refresh requirement.

## Refresh selected examples

Normal site builds reuse the approved pinned bundle; docs edits do not regenerate
captures. To refresh one or more examples, first review their complete replacement
images, matching text and public provenance, then use `pack` above to create a
replacement-only ZIP. Keep each existing public `id` and include every page of
each selected example. Update its source revision, actual/staged classification
and omission disclosure honestly; do not mix a new image with an older transcript.
Retained examples keep their own revisions; a refresh does not make the whole
gallery evidence for the replacement's product or rendering-tool version.
Compare the new examples with retained neighbors for font, color, terminal width,
page captions and readability. A visual style change may justify refreshing more
examples, but does not require recapturing the whole gallery.

Record the reviewed replacement ZIP's SHA-256 from `pack`. With a release-mode
`site/bundle.json`, create a new complete candidate:

```sh
python3 tools/site/site.py replace \
  --replacement .site-output/replacement-examples.zip \
  --replacement-sha256 REVIEWED_REPLACEMENT_SHA256 \
  --entry update \
  --output .site-output/ballin-gallery-assets-v1.0.0-refresh-1.zip
python3 tools/site/site.py inspect .site-output/ballin-gallery-assets-v1.0.0-refresh-1.zip
```

Repeat `--entry` for each existing ID being replaced. The command retrieves the
exact release/asset identified by the pin and verifies its identity and hash.
For offline reuse, supply `--bundle PATH_TO_PRIOR_ZIP`; its bytes must match the
pin's size and SHA-256, but this does not recheck the remote release state.
`--pin PATH` selects another reviewed release pin. Bootstrap mode is rejected
because there is no approved complete bundle to preserve.

The replacement ZIP must contain exactly the named entries, with complete images,
text and public provenance. The command preserves entry order and every untouched
entry and file byte, rebuilds per-file hashes, and validates the complete candidate
against the same archive/path/image safety rules as a normal bundle. It refuses
missing or extra entries, unknown IDs, invalid inputs and an existing output path.
An existing canonical README Update designation must remain; to transfer it,
replace both affected entries together and designate exactly one of them.
Use a separately reviewed full `pack` selection to intentionally add or remove
entries. The result reports its hash, size, replaced/retained IDs and base identity;
it does not modify the release pin or establish publication approval.

Review the complete candidate using the offline build/preview procedure below,
with a separate ignored candidate pin containing its new size/hash. Retain the
base bundle and pin. After separate publication approval, upload the complete ZIP
under its new clearly named `ballin-gallery-assets-vX.Y.Z-refresh-N.zip` asset name
on the mutable product release. Verify retrieval and review the actual new
release/asset identity before
repinning through an ordinary source change. Deployment remains a separate stage.

## Attach to the actual product Release

Name the ZIP clearly as gallery assets, for example
`ballin-gallery-assets-v1.0.0.zip` or
`ballin-gallery-assets-v1.0.0-refresh-1.zip`. These fit the supported
`ballin-gallery-` filename prefix; use lowercase letters, digits, dots and hyphens
before `.zip`. The clear filename is sufficient; releases do not need a repeated
gallery explanation or link. If useful, add an optional release note: “The gallery
assets ZIP contains website example images and matching text. You do not need it
to install or use Ballin.” Keep published release notes canonical in GitHub Releases.

Release publication and asset upload are separate authorized operations. GitHub
supports adding assets to an already published mutable release. A published
immutable release cannot have assets added, replaced or deleted; see
[GitHub's release editing guidance](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#editing-a-release).
Initial real stable-install captures happen after stable publication. Before
publishing a product release intended for later gallery attachment, verify that
it will remain mutable under the current repository and owner-enforced release
policy. Before uploading, verify the actual target release is mutable and inspect
effective version-tag rules. Version-tag protection and asset immutability are
different controls. If immutability forbids later attachments, stop for a reviewed
resolution; do not relax controls or create a workaround asset-only prerelease.
A 404 from the legacy tag-protection endpoint does not establish whether tags are
protected.

After separate upload authorization, the ordinary candidate command is:

```sh
gh release upload v1.0.0 .site-output/ballin-gallery-assets-v1.0.0.zip \
  --repo JBallin/ballin-scripts
```

Do not use `--clobber`. Use a new asset name for replacement output. Preserve the
previous asset and pin until the replacement has been reviewed and retrieved.
Local mock tests cover the transfer contract. Verify permissions, identity,
hashes and post-publication attachment/protection compatibility through an actual
handoff before relying on it, without changing settings. Actions artifacts are transient build
transport, not the approved gallery's durable storage.

## Pin and verify

After an authorized upload, obtain exact product Release and asset IDs through
`gh api repos/JBallin/ballin-scripts/releases/tags/v1.0.0`. Verify the tag resolves
to the approved product commit, dereferencing annotated tags. Replace the
bootstrap object in `site/bundle.json` through an ordinary reviewed change:

```json
{
  "mode": "release",
  "release": {"id": 123, "tag": "v1.0.0", "commit": "FULL_40_CHARACTER_COMMIT_SHA"},
  "asset": {
    "id": 456,
    "name": "ballin-gallery-assets-v1.0.0.zip",
    "size": 789,
    "sha256": "EXACT_64_CHARACTER_SHA256"
  }
}
```

These numbers are schema examples, not usable pins. The retriever addresses the
Release and asset by ID, checks stable published status, membership, tag/commit,
name, size and available GitHub digest, then verifies the downloaded ZIP hash.
It never selects `latest` or a newest asset. Optional `GH_TOKEN`/`GITHUB_TOKEN`
supports authenticated retrieval; Actions supplies its read-only contents token.
Credentials are not forwarded to asset-storage redirects.

The ZIP reader rejects traversal, absolute/ambiguous paths, duplicate members,
symlinks/devices, encrypted or unsupported members, unexpected files/schema fields,
oversize content, suspicious compression ratios and hash disagreement. It never
extracts arbitrary archive paths. A local offline verification uses the same pin:

```sh
python3 tools/site/site.py build --bundle .site-output/ballin-gallery-assets-v1.0.0.zip \
  --output .site-output/pinned-review
```

Omit `--bundle` to exercise actual authenticated retrieval only when the real pin
and network access exist. Local file builds validate pin integrity but cannot
establish remote Release identity or storage durability. Review `build.json`,
`gallery/manifest.json`, all four sections, text and images before activation.

## Shared Update example and public links

Stable public images use the configured origin/base followed by
`/gallery/ENTRY_ID/output-001.png` (and subsequent page numbers); matching text
uses `text.txt` in that directory. For root hosting this is
`https://getballin.com/gallery/ENTRY_ID/output-001.png`. Keep the
approved entry ID stable during refreshes. The site serves current examples only.
Historical README revisions embedding these unversioned URLs will show current
images alongside their historical text; Git history cannot freeze an external URL.
Source labels and the gallery's matching transcript identify the current example.

`python3 tools/site/site.py readme-example BUNDLE.zip` prints expandable canonical
Update text directly from the selected gallery entry without editing the README.
After the real public asset URLs are verified, use `--image-base
https://getballin.com` to include those same images for root hosting. In project
mode, use `--image-base https://jballin.github.io/ballin-scripts` instead. Review the
fragment in the follow-on README integration; preserve expandable actual text and
labels. Image, site transcript and generated README fragment share the one bundle
input derived from the canonical scenario/capture source. Do not maintain a second
example. Actual capture sources remain private unless separately approved.

Validate browser navigation, full-size image viewing, text copy/download and
fragments when publishing or changing public links. Keep the README self-contained.

## Deploy and recover

`.github/workflows/pages.yml` assembles and uploads one complete snapshot; the
deploy job receives only that artifact. A docs change reuses the pinned bundle.
A bundle-pin change includes the current docs. Neither operation can publish a
partial tree. Only trusted `main` pushes or a manual `main` dispatch may deploy;
there are no privileged PR events or hosted previews. The build token has contents
read permission; only the deployment job receives Pages write and OIDC permissions.

Automatic paths match the actual build inputs: `README.md`, `CONTRIBUTING.md`,
`SUPPORT.md`, `SECURITY.md`, `LICENSE.md`, `docs/**` (including existing images),
`site/**` (template, styles, renderer lock and bundle pin), `tools/site/**`, `.nvmrc`
and `.github/workflows/pages.yml`. Generator/tool changes under `tools/output-gallery`
do not regenerate or deploy assets; deliberate packaging and a pin update activate
them. CI also exercises site tests on PRs without release access or deploy rights.

One workflow concurrency group serializes assembly through publication without
canceling an active deployment. Every queued run checks out current `main`, even
for an older event. Before deployment, changed publication inputs invalidate a
superseded snapshot; the newer relevant run or a manual rerun builds fresh state.
Unrelated product commits do not block the same complete documentation snapshot.

Once Pages settings and the `github-pages` environment are separately configured
and deployment is authorized, the manual recovery command is:

```sh
gh workflow run pages.yml --ref main --repo JBallin/ballin-scripts
```

This is a deployment action, not a local build. Inspect its actual result before
claiming publication. A workflow file alone does not enable Pages or prove its URL.

For rollback, review a change restoring the known-good bundle pin and any affected
documentation/site inputs, validate that complete state, then deploy through this
same process. Do not rerun a historical artifact or silently switch to bootstrap.
If the old immutable identity is unavailable or fails verification, preserve the
current deployment and resolve the handoff. No settings changes, tag moves or
installer release-selection changes are part of site rollback.
