# Documentation site and public gallery

*Maintainer guide to building complete documentation snapshots and deliberately activating approved gallery assets.*

The website renders the root README and canonical guides in this repository.
The contribution guide lives at root `CONTRIBUTING.md`; support and security
guides live in `.github/`. Their site URLs remain `/CONTRIBUTING.html`,
`/SUPPORT.html`, and `/SECURITY.html`.
GitHub Releases remain the published release-note history. Product release
preparation belongs to [Releasing Ballin](releasing.md); VM validation belongs to
[Installation testing](installation-testing.md). The site does not change the
installer's stable release selection or require gallery regeneration per release.

## Start-to-finish workflow

Follow this route directly or delegate it. Reuse existing specific approvals;
bring the maintainer in for missing authority or a new material decision.
Preparation/review does not authorize access changes or publication.

- **Docs only:** keep the pin, [build/review](#build-locally), then submit; no capture
  or upload. Consider automatic deployment before merge, as in step 5.
- **Initial gallery:** follow all steps; retain explicit bootstrap until activation.
- **Selected refresh:** begin at step 2 with the [replacement recipe](../tools/output-gallery/README.md#replace-selected-examples)
  and verified pinned base; preserve untouched entries and their source revisions.

1. **Prepare:** choose source and scope under [Releasing Ballin](releasing.md).
   Test the exact merged SHA before publication; real stable-install captures
   follow approved publication. Confirm [prerequisites/access](../tools/output-gallery/README.md#generate-review-output).
2. **Generate and review:** check commands, every image page, matching text and
   actual/staged/source claims. With approval of the selected public files,
   [pack/replace and preview](../tools/output-gallery/README.md#package-approved-examples) a verified complete candidate.
3. **Synchronize README:** export a changed canonical Update from the same bundle
   using the [shared-example recipe](../tools/output-gallery/README.md#canonical-readme-update-illustration).
   Check/update every image, label and full embedded transcript before activation;
   the tools do not edit README automatically.
4. **Upload separately:** verify the product release/tag/commit, mutability and
   uploader access, then [upload the exact approved ZIP](../tools/output-gallery/README.md#upload-the-reviewed-bundle).
   Confirm its actual identity; inspect uncertain results before retrying.
5. **Activate:** replace offline placeholders with [verified real IDs](#pin-and-verify),
   retrieve and QA the complete snapshot, including coordinated README text.
   Authorize deployment **before** relevant `main` merges, which trigger production publication once enabled.
6. **Verify delivery:** check deployment results, public PNG/text bytes and
   navigation. A first README image-link consumer waits for the verified URL and
   its own checks/reviews and merge authorization; later refreshes repeat step 3.

Record completed steps, exact revisions/identities/hashes, README consumer and
next blocked action in ignored records without credentials. On resume, recheck
branch and external release/workflow state before retrying; an attempt is not
success. Preserve evidence and follow [recovery](#deploy-and-recover) on failure.

## Build locally

### Build and run the current checkout

Use Node.js from `.nvmrc` and Python 3.9 or newer. Run these commands from
the root of the repository checkout you want to validate, not an older review checkout.
Install dependencies once per checkout (and again when its lockfiles change):

```sh
npm ci --ignore-scripts
npm ci --prefix site --ignore-scripts
```

Use **one output path, `.site-output/local/current`, and port 8000** for routine
local work. Build it, then start the server once:

```sh
python3 tools/site/local.py build && python3 tools/site/local.py serve
```

**Validation URL: `http://localhost:8000/`.** Keep that terminal running. Open
the URL in a browser on the same computer. This standard local preview always
uses root hosting, without `/ballin-scripts/`.

After editing source, run this in a second terminal from the **same checkout**:

```sh
python3 tools/site/local.py build
```

Wait for a successful build, then refresh the same browser URL. **Do not restart
the server, choose another output directory or change ports.** The existing
server reads the current build on subsequent requests. There is no file watcher
or automatic browser reload. Local responses disable browser caching.

The helper builds and validates a complete candidate before atomically switching
`current` to it. A failed rebuild leaves the previous site available; it does not
mean your edits are visible. Old builds remain private under `.site-output/local/builds/`
for existing requests and diagnosis, not as additional review destinations. The
helper refuses to replace an unmanaged file, directory or link at `current` and
serializes rebuilds. It never deletes source, captures or prior build evidence.
Refresh after completion rather than navigating during the switch: individual
responses use one snapshot, but a browser's multiple requests can straddle a rebuild.

Stop with Control-C only when finished, or when changing the preview helper
itself. To resume serving later, run `python3 tools/site/local.py serve`; rebuild
first if source has changed. If port 8000 is already occupied, check which
checkout/server owns it. Reuse the standard server for this checkout; do not
silently start another port or stop an unrelated process. An older private gallery
server is separate and remains untouched until an intentional switch.

The startup output records the stable path and revision at server start. After a
rebuild, inspect `.site-output/local/current/build.json` for the current source
revision and dirty state. Neither command opens a browser or publishes the site.

For tooling/template/workflow changes, also run `python3 tools/site/test_site.py`
(or `npm --prefix site test`) after both dependency installs. Follow
[Website QA](#website-qa) for rendered validation; successfully serving HTML
alone is not visual QA.

### Advanced: serve an existing snapshot

To resume review without rebuilding, use the exact previously recorded output:

```sh
python3 tools/site/preview.py --site PATH_TO_COMPLETE_SNAPSHOT --port 8000
```

`--site` selects the directory containing `build.json` and `index.html`, not its
parent. The server binds only to `127.0.0.1` and serves only that snapshot.
The URL depends on the **snapshot's hosting base**, not its directory name:

- Root-hosted snapshot: `http://localhost:8000/`.
- Project-hosted snapshot: `http://localhost:8000/ballin-scripts/`.
  Older snapshots without hosting metadata also default to `/ballin-scripts`.

These directory URLs serve `index.html` without changing the browser address.
Explicit `/index.html` URLs still work. In project mode, `/` and the base without
its trailing slash redirect to `/ballin-scripts/`. This is local preview behavior;
public-host redirects are configured separately. Use the startup URL as the authority. `--base` overrides routing only; it does
not rebuild the HTML or fix embedded links. Build with the intended base using
[Hosting configuration](#hosting-configuration) instead of overriding the server
to compensate for a mismatched snapshot.

If port 8000 is occupied, preserve the existing server. Stop it only if it belongs
to your review, or choose an explicit unused port with `--port PORT` and use that
port in the printed URL. `--port 0` is an optional free-port allocation, not the
repeatable default: it may choose a different port on every launch. Never reuse
an earlier dynamic URL without checking the current startup output. Stop a
server with Control-C in its terminal, or send TERM to its verified printed PID.

An existing private gallery snapshot may contain local presentation changes and
older source. Re-serving it does not validate the current PR. Record its revision
and any adapters separately. The server reads output files on each request, so
an authorized in-place output change appears after reload, subject to browser
caching; source edits alone never update that snapshot.

Failed builds retain a `.site-build-*` directory beside the chosen output for
diagnosis; successful snapshots replace nothing. Never point build or packaging
output at raw captures or source inputs. `.site-output/`, `site/node_modules/`
and Python caches are ignored.

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

### Review locally before hosted previews

Use this process for human or agent review while hosted PR previews are unavailable:

1. **Select the snapshot.** For routine work, rebuild `.site-output/local/current`
   with `python3 tools/site/local.py build` and reuse its running server. For
   specialized gallery evidence, use the exact private
   review snapshot recorded in the task handoff. Record its directory, source
   revision and dirty state. An older snapshot with local presentation changes
   is not an exact current-head build. Bootstrap outputs intentionally have no
   gallery; use the reviewed bundle or existing private gallery snapshot when
   gallery QA is needed. Preserve capture hashes and publication boundaries.
2. **Serve it on the review computer.** Use `python3 tools/site/local.py serve`
   for the standard preview if it is not already running. For a specialized snapshot, run
   `python3 tools/site/preview.py --site SNAPSHOT_DIRECTORY --port 8000`, using that
   directory, then keep the process running. Use the printed URL,
   including its project base path. The browser must run on the same computer:
   `localhost` in a cloud browser points to that cloud computer, not the local Mac.
   Keep the server loopback-only; local QA needs no public tunnel or deployment.
3. **Open an inspectable browser tab.** In the existing Codex task attached to
   that Mac, inspect the current browser inventory and use the built-in provider
   it actually returns. Create or select a tab and navigate to the printed URL;
   do not copy a provider ID from another task. Confirm the page title, URL and
   screenshot before starting the [Website QA](#website-qa) checklist. Use fresh
   page state for interactions. A human can open the same URL in a browser on
   that Mac.
4. **If the task has no browser connection, check the existing local task.**
   Another authorized task on the same Mac may already have working built-in
   browser access. Reuse that task for review rather than assuming the site or
   localhost is inaccessible. A queued browser panel has not opened an
   inspectable tab. If no authorized browser is available, report the specific
   access gap and leave rendered QA incomplete while continuing static checks.
   An external browser needs its own applicable authorization; do not retry
   denied access or change permissions as a workaround.
5. **Review, refresh and record.** Check desktop, wide and narrow layouts and the
   image/text/navigation flows below. After source changes, rebuild the standard
   output and refresh its existing server. For a specialized snapshot, rebuild
   and serve the selected output. After an authorized presentation-only update to the selected
   snapshot, reload the page and confirm the changed content; there is no live
   reload. Record observed results, failed or blocked checks and any capture
   provenance limits. Reset temporary viewport changes and close review-only
   tabs afterward. HTTP success alone does not complete rendered QA.

## Hosting configuration

`site/deployment.json` defines the intended canonical origin and base for the
Actions build: `https://getballin.com` and an empty base for root hosting. This
controls navigation, gallery/image/text paths, canonical URLs, sitemap and social
metadata together. Source links continue to point to the exact GitHub revision.
The existing branded PNG is copied to `docs/assets/brand/social-preview.png` and
used in static Open Graph and Twitter large-card metadata with absolute URLs.

The standard local preview above stays root-hosted. For a separate GitHub
project-site compatibility check, override both values explicitly:

```sh
snapshot=".site-output/review/project-$(date +%Y%m%d-%H%M%S)"
python3 tools/site/site.py build --output "$snapshot" \
  --origin https://jballin.github.io --base /ballin-scripts &&
  python3 tools/site/preview.py --site "$snapshot" --port 8000
```

Stop your previous review server before reusing port 8000. This project snapshot's
validation URL is **`http://localhost:8000/ballin-scripts/`**, including
the project base path. The default root build above does not use that prefix.
To select a
different durable deployment target, edit the same configuration, or supply
`--config /path/to/config.json` with exactly `origin` and `base`. Overrides affect
one build only. Local serving stays loopback-only while canonical/share URLs
remain those of the intended public target.

Configure `getballin.com`, DNS and HTTPS separately in Netlify after approval.
The repository's origin/base configuration does not set up a Netlify site, team,
plan or domain. The visible Netlify footer credit is included on every page;
the documentation index links to project resources, including the shared Code of Conduct. The OSS application has been submitted,
but acceptance and the separate-team arrangement remain external prerequisites.
When changing hosting, verify the configured origin/base against deployed pages,
assets, gallery viewers, transcripts, fragments, sitemap and social metadata.
Check certificate/redirect behavior and inspect sharing-platform previews after
publication; local metadata checks cannot establish crawler behavior.

## Website analytics

Cloudflare Web Analytics is the selected website analytics service, separate from
Ballin's CLI analytics Worker and D1 data. The shared page template supports the
Cloudflare beacon on home, documentation, gallery and image-viewer pages.

**Setup to-do:** in Cloudflare Web Analytics, add the intended public hostname
(`getballin.com`) and obtain its public site token. This account setup has not
been performed. Put that beacon token in `site/analytics.json` in place of `null`
in a reviewed change. It is a public identifier embedded in HTML, not an API
credential; never put a Cloudflare API token or account secret there. Use manual
beacon installation and avoid enabling automatic injection as well, which could
count visits twice. No CLI analytics credentials or data are reused.

The committed null token disables collection. The Netlify production workflow passes
`--analytics`; it includes the beacon loader only once a valid token is configured.
Ordinary local builds omit it. Even an analytics-enabled snapshot loads the
third-party script only when the browser origin exactly matches the build's
canonical HTTPS origin, keeping loopback and other preview hosts out of reports.
Use `--analytics-config /path/to/config.json` for isolated fixture checks without
editing the committed token. Do not serve a fixture token on the public site.

After separately authorized setup and deployment, verify one beacon per page,
successful requests and page views in the Cloudflare dashboard. Local fixture
checks do not verify live ingestion. Set the token back to `null` and deploy the
reviewed change to disable future collection. See Cloudflare's
[manual installation guide](https://developers.cloudflare.com/web-analytics/get-started/).

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
- Open an example and use its page links to reach a continuation page and return.
  Check the complete fitted image, original-PNG zoom link and readable transcript
  at narrow widths; never fix clipping by cropping evidence.
- Activate matching-text links with the target collapsed, expanded and collapsed
  again at the same fragment. Each click should open its ancestors and align the
  target after layout settles. Check long transcript lines and Copy spacing.
- Test keyboard Copy and its visible result without reading pre-existing clipboard
  contents. Verify the Download target and, when permitted, the saved transcript.
  A timeout or permission prompt is not successful completion; inspect an uncertain
  outcome before retrying. Keep browser permissions and unrelated files unchanged.
- Check concise recording/staged, historical and incomplete labels. Check that
  reviewed commands shown in images match what actually ran. Keep the selectable
  command, its recorded/illustrative label, source and capture notes in Details
  instead of duplicating a visible command card. Verify guide links point to the
  relevant task and reciprocal links include only examples in the selected bundle.
  Keep reproduction instructions in the installation guides.
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

Generate and review output deliberately on the local Mac using the
[gallery recipes](../tools/output-gallery/README.md#generate-review-output).
Nothing captures or renders in deployment CI. Use the
[publication selection and packaging recipe](../tools/output-gallery/README.md#package-approved-examples)
to include only approved images, matching UTF-8 text and minimal public provenance.
Raw ANSI, command/answer/environment metadata and generation inputs stay private.
Hash agreement proves byte identity, not faithful execution or absence of secrets.

Choose one canonical Update entry with `readmeUpdate: true` when preparing the
shared README example. A staged example remains staged. Review every image page,
the matching text and disclosures, and record the candidate ZIP's size and SHA-256.
Use the [offline candidate preview](../tools/output-gallery/README.md#preview-a-candidate-bundle)
for a complete-site check before upload; its placeholder identity is not a live
release pin or publication approval.

## Refresh selected examples

Normal builds reuse the pinned bundle. For an asset refresh, follow the
[replacement recipe](../tools/output-gallery/README.md#replace-selected-examples):
verify the base pin, replace complete explicitly named entries, and preserve the
rest byte-for-byte. Compare rendering with retained neighbors for visual consistency.
The canonical README designation must remain, or transfer within the selected set.

Make the [refresh summary](../tools/output-gallery/README.md#review-the-refresh-summary)
easy to find in the review handoff: list replaced IDs, the retained count and the
candidate bundle/hash, with local preview links to the replaced examples. Save
the full `replace` output with the evidence. Build the complete candidate site
and review those examples in the browser before upload or activation; record
the result for each replaced ID.

If the canonical Update entry changes, the same task must export and check the
README's image list, labels and full embedded text against the candidate bundle,
and update the consumer when they differ. Coordinate that source change with pin
activation; do not deploy the new image and leave README text for later. The
[shared Update instructions](#shared-update-example-and-public-links) cover the
stable URL and historical README caveat. If only another entry changed, verify
that the canonical Update entry was retained unchanged.

Retain the known-good bundle/pin, use a fresh candidate output path, and keep
review, public upload, real-ID repinning and deployment as separate stages.

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

Use the [reviewed-bundle upload recipe](../tools/output-gallery/README.md#upload-the-reviewed-bundle)
only after separate authorization for the exact release and file. Use a new asset
name for replacement output; preserve the previous asset and pin until the new
one is reviewed and retrieved. If the upload result is uncertain, inspect the
release's actual assets before retrying. Local mocks do not establish live access
or storage durability. Actions artifacts are transient build transport, not the
approved gallery's durable storage.

## Pin and verify

After an authorized upload, obtain exact product Release and asset IDs through
`gh api repos/JBallin/ballin-scripts/releases/tags/v1.0.0`. Verify the tag resolves
to the approved product commit, dereferencing annotated tags. Form an ignored
proposed pin using those verified identities first; only after retrieval and
complete-site review, put it in `site/bundle.json` through an ordinary reviewed
change:

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

These numbers are schema examples, not usable live pins. Do not copy the offline
review pin's placeholder IDs into a committed activation pin. The retriever addresses the
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
python3 tools/site/site.py build --pin .site-output/verified-pin.json \
  --bundle .site-output/ballin-gallery-assets-v1.0.0.zip \
  --output .site-output/pinned-review
```

Build a second new output with the same `--pin` but without `--bundle` to exercise
live retrieval after the real IDs and network access are available. Local file
builds validate pin integrity but cannot establish remote Release identity or
storage durability. Review `build.json`,
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
fragment in the README consumer; preserve the full expandable matching text and
labels. Whenever generation or refresh changes that canonical Update entry, this
export/compare/update is required before activating the bundle. Include all its
image pages and use the same bundle for the image and embedded text; `readme-example`
prints a fragment but does not modify README. Follow the
[detailed shared-example recipe](../tools/output-gallery/README.md#canonical-readme-update-illustration).
Image, site transcript and generated README fragment share the one bundle input
derived from the canonical scenario/capture source. Do not maintain a second
example. Actual capture sources remain private unless separately approved.

Validate browser navigation, full-size image viewing, text copy/download and
fragments when publishing or changing public links. Keep the README self-contained.

## Deploy and recover

`.github/workflows/netlify.yml` builds and uploads one complete snapshot, then
publishes only that artifact with an integrity-locked Netlify CLI. The dedicated
`tools/site/netlify-cli/package-lock.json` records its dependency tree. The deploy
job installs it from current `main` with `npm ci --ignore-scripts` before exposing
Netlify credentials, then invokes the installed binary outside the checkout.
Review the complete lockfile when updating the CLI. A docs change reuses the
pinned bundle; a bundle-pin change includes current docs. Gallery generation and
asset approval stay local. GitHub Pages deployment and its write/OIDC permissions
are removed. No Netlify Git integration or automatic PR previews are needed.

Publication is off until the repository variable `NETLIFY_DEPLOYS_ENABLED` is
explicitly set to `true`. Before enabling it, separately authorize and configure
the Netlify site and the GitHub `netlify-production` and `netlify-preview`
environments. Require production approval, restrict both environments to workflow
runs on `main`, and store the intended `NETLIFY_SITE_ID` variable and
`NETLIFY_AUTH_TOKEN` secret in each environment. Use the minimum permitted token
access. Confirm the separate-team/OSS arrangement without changing the existing
legacy team's plan or projects. These are setup instructions, not completed setup.

Relevant `main` pushes publish production once enabled. The path filters cover
`README.md`, `CONTRIBUTING.md`, `.github/SUPPORT.md`, `.github/SECURITY.md`,
`LICENSE.md`, `docs/**`, `site/**`, `tools/site/**`, `.nvmrc` and the workflow.
Generator-only changes under `tools/output-gallery` do not regenerate assets.
CI tests PRs without deployment credentials. Production assembly/publication is
serialized without canceling active runs. Queued production runs build current
`main`, not the triggering historical commit. After environment approval, changed
publication inputs invalidate a superseded snapshot. Unrelated product commits
do not block an otherwise current complete documentation snapshot.

Authorize production before merging relevant changes or manually dispatching:

```sh
gh workflow run netlify.yml --ref main --repo JBallin/ballin-scripts -f target=production
```

For an optional on-demand preview, dispatch the trusted workflow on `main` with a
reviewed same-repository branch or commit. The build has no Netlify credentials;
the deployment job runs the pinned CLI outside the source checkout and uploads
only the completed static artifact. Review the selected code before authorizing
its build. A preview uses Netlify's default draft deploy, never `--prod`, so it
does not replace production. Preview builds omit analytics even if a token exists.
Previews are not required for contributors or every PR, and run in a separate
serialized lane so they do not delay production approval.

```sh
gh workflow run netlify.yml --ref main --repo JBallin/ballin-scripts \
  -f target=preview -f preview_ref=REVIEWED_COMMIT
```

Both commands publish externally, not just build locally. Inspect the returned
deploy ID and URL, final Netlify state, access and retention before sharing or
claiming success. Draft URLs are not inherently private. Verify production domain,
HTTPS, navigation, assets and downloads after separately authorized publication.
The seven-day Actions artifact retention is not Netlify preview retention.
A workflow file does not establish live hosting or OSS-plan approval.

For rollback, review a change restoring the known-good bundle pin and any affected
documentation/site inputs, validate that complete state, then deploy through this
same process. Do not rerun a historical artifact or silently switch to bootstrap.
If the old immutable identity is unavailable or fails verification, preserve the
current deployment and resolve the handoff. No settings changes, tag moves or
installer release-selection changes are part of site rollback.
