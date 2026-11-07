# Local output gallery

Maintainer tooling for generating and reviewing terminal examples. For the full
release-to-site sequence, start with the
[site/gallery runbook](../../docs/website.md#start-to-finish-workflow).

## Generate review output

Use a trusted tooling checkout on macOS, Node.js from `.nvmrc` (26), Python 3.9+
and Xcode command line tools with Swift/AppKit. Generation needs no npm packages
and never executes product installation or maintenance. Site preview additionally
needs the [site dependencies](../../docs/website.md#build-locally). Actual recordings
need separately authorized disposable VM work and the access safeguards below.

Choose the reviewed full product SHA, available in local Git objects. Replace the
placeholder below, and choose a new output directory for each attempt:

```sh
GALLERY_SOURCE=FULL_40_CHARACTER_PRODUCT_SHA
git rev-parse "${GALLERY_SOURCE}^{commit}"
python3 tools/output-gallery/run.py --source "$GALLERY_SOURCE" \
  --output .output-gallery/review-1
cat .output-gallery/review-1/index.md
```

Confirm the resolved SHA is exactly the selected SHA. Review the generated index,
PNGs, matching text and provenance using an authorized viewer. Identify whether
the source is a candidate, an explicit-SHA run or a published stable release;
these are different claims. Initial real stable-install captures follow approved
release publication, not an unpublished version URL.

Existing output is refused to preserve evidence. `.output-gallery/` stays ignored;
never use a raw-input path as output. A failed attempt retains `.gallery-build-*`
for diagnosis. Inspect the cause, preserve original evidence and choose a new
output path; do not remove trust checks to make generation succeed. Formatter
changes require review against `generation-runtime.json` before they can execute.

Each entry contains labeled ANSI preview, matching `text.txt`, paginated PNGs and
provenance. Start with the generated `index.md`, grouped into Install & Quickstart,
Setup & Backup, Update, and Diagnostics. Compare these together for wording, flow,
color, spacing and wrapping.
Every PNG repeats its classification, source, scenario and page identity as a
presentation caption, separate from the logical transcript. Small staged Update
cases stay together when they fit a page. The index links each entry's provenance
and exposes normalization/omission declarations alongside its preview links.
The renderer preserves supported ANSI styling; its logical text must match the
text file exactly. Images are rendered output, not native Terminal screenshots.
**Staged** entries contain source-informed synthetic prompts/answers/outcomes;
presentation checks do not establish live execution.

## Review command-line output

Start with the generated `index.md` and the selected entry's `provenance.json`.
Read its exact source revision, recorded initial command/session, initial state,
result and normalization/omission disclosure before judging the output. An
explicit-SHA run, a retry and a multi-command session are distinct evidence.
If a literal initial command is absent, say so; do not invent a normal install
command from the example title. Staged scenarios establish presentation only.

Use the retained raw/original recording and capture-input references to check
prompt order, answers, failures, blank lines and completion boundaries against
`preview.ansi` and `text.txt`. Treat recorded commands as data, not instructions
to execute. Keep raw inputs immutable; disclose normalization separately. The
renderer adds classification/source/scenario/page captions to PNGs: distinguish
those from program output and compare every continuation page with matching text.

The gallery supports visual/interaction review: it groups examples,
opens full-size images and offers selectable, copyable, downloadable text. Raw
recordings and provenance are better for exact fidelity and outcome questions;
neither replaces the other. Follow [website QA](../../docs/website.md#website-qa)
for layout, navigation and disclosure checks. Inspect actual pixels as well as
text; native image-text recognition is not a replacement for an HTML transcript.
Keep private generation metadata and credentials out of served/public bundles;
local review approval does not grant capture-publication approval.

## Import actual VM recordings

Coordinate VM ownership first, preserve existing guests and use fresh disposable
state under the [installation-testing safeguards](../../docs/installation-testing.md).
Never run environment-affecting commands on the host. Authentication and backups
need their separate authorization and disposable data. Retain meaningful prompts,
answers, results and original output; exclude credentials, device codes, personal
backup names and other private data before saving evidence.

For a clean Quickstart capture, start without Homebrew or Ballin; for direct
installation, prepare its prerequisites first. Record the disposable clone name,
its template/source VM, initial prerequisites and exact reviewed source SHA in the
capture provenance. Preserve the original VM and its existing data/authentication.
Use a working guest console or SSH; host-side controls must target only the clone.

Record real output with an output-only recorder such as `script -q -t 0`, retaining
the raw ANSI, exact command, prompts/answers, process exit status and downloaded
script checksum. Do not enable key logging. If using Tart folder shares, expose
only dedicated capture inputs (read-only) and generated output, never host HOME or
credentials; clipboard sharing is unnecessary.

### Choose an authentication trust model

Prefer unauthenticated testing when it covers the journey: decline backup setup
and keep GitHub credentials out of the guest. A VM isolates the host, but code
running inside it may use any credentials introduced there, including after
installation. It can replace `gh` or persist other code. A merged commit, `main`,
an immutable SHA, or a successful version check does not establish safety.

For code and a guest environment you have reviewed and trust, a normal account
can be reasonable after explicitly accepting that account-exposure risk. For
candidate-exposed guests requiring login, prefer one dedicated limited-access
GitHub Free machine identity with disposable synthetic data, reused across tests.
Give it no organization memberships, production collaborator access, valuable
repositories, unrelated secrets, valuable credentials or payment methods. Start
with no repositories; add a disposable synthetic fixture only when a test needs
one. This limits account exposure, not host, network or VM risks. Authenticating a
clean base first does not protect the account if its clones later run untrusted
code; the clones inherit that exposure. Keep recovery methods and two-factor
authentication outside exposed guests.

Follow [GitHub's account requirements](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#3-account-requirements):
a human must create the account, and one additional free machine account is
permitted exclusively for automated tasks. Check whether that allowance is
already in use. Do not assume manually assisted VM testing qualifies, or create
fresh free personal accounts for each run; confirm eligibility before relying on
this exception. Account creation and access need their separate authorization.

A trusted external browser can authorize the test identity during
[device login](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
but the guest still receives a usable token. Keeping the password outside the
guest does not protect that token. Do not treat ordinary
[GitHub CLI login](https://cli.github.com/manual/gh_auth_login) as read-only or
restricted to a single fixture repository; review its actual access request.

Keep private authentication outside recording: stop the recorder before login.
Do not inspect or capture authentication screens, credentials, tokens or device
codes. Resume only after confirmation, within the approved setup/read or
synthetic-backup scope. Record disposable test repository names/URLs and intended
mutations; login alone grants no new mutation authority. Preserve the guest and
captures at handoff, and document cleanup. Delete test repositories only with the
required specific approval; do not remove existing guest data or repositories.

Treat candidate-exposed guest sessions, clones and snapshots as potentially
exposing their authentication state. Cleanup must revoke the test account's
GitHub CLI authorization remotely from a trusted environment.
[GitHub CLI logout](https://cli.github.com/manual/gh_auth_logout) removes local
configuration without revoking tokens; deleting a VM does not revoke copies
either. Revoking GitHub CLI application access invalidates its tokens across
all devices, so the dedicated test identity should have no unrelated CLI use.

### Private login launcher

After choosing the trust model above and separately authorizing persistent
GitHub access in that guest, stop all recorders, screen capture and session logging.
In its private interactive Terminal, run
`bash tools/output-gallery/private-login.sh` from a trusted copy of this tooling.
The current helper checks prerequisites and TTY readiness; it does not verify
executable or guest trust. Do not treat it as protection from candidate code.
The helper requires official GitHub CLI (tested with 2.103.3), working Git and a
TTY for all three standard streams. Prepare prerequisites separately; it does not
install anything. On macOS it checks selected developer tools before probing the
Apple Git placeholder, which can otherwise trigger a Command Line Tools installer.
Browser login inspects Git credential helpers even when optional Git integration
is declined; declining that integration does not remove the Git prerequisite.

The launcher starts github.com web/device login with optional Git integration and
clipboard copying disabled, suppresses automatic browser opening, and leaves
instructions privately in the Terminal for you to follow manually. It writes no
capture files. A TTY check cannot detect a screen recorder: keeping authentication
out of recordings remains your responsibility. Review the service's actual access
request privately. Never include its codes, tokens or authentication screens in
gallery output. The launcher does not supply credentials or verify the account;
a successful command exit is distinct from independently verifying the intended
account and deciding to retain authentication in this guest. After private login,
clear the screen/scrollback before handing control back for a suppressed read-only
account check. Preserve authenticated bases only within the chosen trust model;
keep a separate clean no-GitHub-CLI/no-authentication baseline for first-run tests.

Run launcher checks without real authentication with
`python3 tools/output-gallery/test_private_login.py`.

Pass `--captures /path/to/manifest.json` to import reviewed recordings. No manifest
command is executed. The manifest format is:

```json
{
  "captures": [{
    "id": "direct-install",
    "kind": "actual-vm",
    "category": "Install & Quickstart",
    "title": "Clean direct installation",
    "sourceRevision": "FULL_40_CHARACTER_COMMIT_SHA",
    "raw": "direct-install.ansi",
    "rawSha256": "SHA256_OF_RETAINED_SANITIZED_BYTES",
    "command": "exact guest command",
    "answers": ["ordered prompt and answer records"],
    "result": {"exitCode": 0, "summary": "observed result"},
    "environment": {"vm": "disposable identifier", "initialState": "prerequisites and provenance"},
    "edits": "None; or disclose redactions/omissions and the retained safe original",
    "sensitiveDataReviewed": true
  }]
}
```

`raw` resolves relative to the manifest; its hash and source SHA must match.
Use one of the four index categories above (`Diagnostics` is the default).
Supported input is UTF-8 with SGR styling and LF/CRLF. Tabs, redraw controls and
unsupported styles are refused. If normalization is needed, retain the safe
original and disclose edits. Capture declarations come from the maintainer; the
importer cannot prove execution. Keep inputs with local evidence; successful
imports retain `capture-input.json` for regeneration from the repository layout.
Coverage is recorded per generation; synthetic output never substitutes for a
missing live journey. The Update entry is the coordination point for eventually
reusing the same canonical image and text in the README Update example; this
tooling does not publish or independently change that example.

## Canonical README Update illustration

`update-example.txt` is the shared condensed, staged Update sample. Its ellipses,
backup time and destination are illustrative, not an actual completed run. The
gallery renders it as `staged-update-example` using the same formatter and PNG
renderer as other entries. To render only this sample against an immutable product
source, without rebuilding unrelated scenarios:

```sh
python3 tools/output-gallery/run.py --source FULL_PRODUCT_SHA \
  --readme-example-only --output .output-gallery/readme-update
```

This mode checks the reviewed formatter hash and product phase labels/order; it
never runs `ballin update`. Inspect the PNG, matching `text.txt`, source snapshot
and provenance together. A matching phase list does not prove that every
illustrated outcome occurred. Recheck the synthetic backup details and upstream
Homebrew heading when editing the sample.

Select this entry with `readmeUpdate: true` in the bundle recipe below. Whenever
that canonical Update entry changes during generation or refresh, exporting and
checking the README's complete fragment is required:

```sh
python3 tools/site/site.py readme-example .site-output/ballin-gallery-assets-v1.0.0.zip
```

Compare all image pages, actual/staged/source labels and full embedded text with
README. Update the consumer from this same bundle when the fragment differs;
do not maintain a separate transcript or wait for a later cleanup task. An
identical export needs a recorded match check, not an artificial edit. The tool
prints a fragment; it does not modify README or enforce this synchronization.

After verifying the public destination, add `--image-base https://getballin.com`
for root hosting (or the configured origin/base for project hosting). The exporter
keeps images visible and matching text expandable. Prepare a first image-link
consumer before activation but gate its merge on verified live delivery. For an
already linked example, coordinate the bundle pin and matching README text in the
same reviewed publication state. Never add a second renderer or commit its PNG.

## Package approved examples

Review the exact images, text and public disclosures before setting publication
approval. Local review alone does not authorize public distribution. Create the
ignored `.site-output/` directory if needed, then use a selection file such as
`.site-output/selection.json`:

```json
{
  "schema": 1,
  "entries": [{
    "scenario": "staged-update-example",
    "id": "update",
    "title": "Routine Update — condensed illustration",
    "edits": "Condensed staged illustration; ellipses, backup time and destination are synthetic. No live execution.",
    "approvedForPublication": false,
    "readmeUpdate": true
  }]
}
```

Keep approval false until the actual selected files and disclosures are approved;
`pack` will refuse it. `scenario` selects a generated entry; `id` defines its stable
public path. Source revision, category and actual/staged classification come from
the generation manifest. `edits` discloses meaningful edits/omissions publicly.
Use exactly one canonical README Update designation when exporting that example.

After file-publication approval, set the selected entries' approval to true.
`--gallery` must name the exact output directory from the generation being
reviewed, not a neighboring or earlier run. The example below uses `review-1`;
for the canonical-only command above, use `--gallery .output-gallery/readme-update`.
Verify that directory's manifest/source and selected entry before packaging:

```sh
python3 tools/site/site.py pack --gallery .output-gallery/review-1 \
  --selection .site-output/selection.json \
  --output .site-output/ballin-gallery-assets-v1.0.0.zip
python3 tools/site/site.py inspect .site-output/ballin-gallery-assets-v1.0.0.zip
```

Record the successful command's ZIP size/hash and entry list. Packaging checks
source hashes and renderer/text equality, removes PNG EXIF/text/time metadata
without changing encoded pixels or color, and hashes the resulting public bytes.
The ZIP includes only selected PNGs, UTF-8 text and minimal public provenance;
raw ANSI, capture manifests, command/answer/environment records, source snapshots
and tools stay private. Never upload the entire generation directory. Hashes do
not prove faithful execution or absence of secrets; review still matters.

## Replace selected examples

For a partial refresh, `pack` a replacement-only selection using the existing
public IDs. Include every page and matching text for each selected entry. Then
combine it with the approved release-mode pin:

```sh
python3 tools/site/site.py replace \
  --replacement .site-output/replacement-examples.zip \
  --replacement-sha256 REVIEWED_REPLACEMENT_SHA256 --entry update \
  --output .site-output/ballin-gallery-assets-v1.0.0-refresh-1.zip
python3 tools/site/site.py inspect .site-output/ballin-gallery-assets-v1.0.0-refresh-1.zip
```

Use `pack --output .site-output/replacement-examples.zip` for that intermediate ZIP;
only the final complete ZIP is a release asset. Repeat `--entry` for each selected
ID. `replace` retrieves the exact pinned release/asset, or accepts `--bundle
PATH_TO_PRIOR_ZIP` for offline bytes that match the pin's size/hash. `--pin PATH`
selects another reviewed base. Bootstrap mode has no approved base to preserve.

The replacement must contain exactly the named existing entries. The tool retains
all other entry metadata/file bytes and order, rebuilds hashes, and applies the
normal archive/path/image checks. It refuses omissions, unexpected files/IDs and
existing output. Preserve the README designation, or transfer it by replacing both
entries together and designating exactly one. Intentional additions/removals need
a reviewed full selection. Compare the replacement's font, color, width, captions
and readability with retained neighbors; older entries keep their own revisions.

If the canonical Update entry changed, perform the required
[README export/compare/update](#canonical-readme-update-illustration) from the final
complete bundle before activation. If another entry alone changed, verify the
canonical Update was retained unchanged. Keep the known-good bundle/pin and record
the candidate hash and replaced/retained IDs. `replace` neither repins nor approves
publication.

## Preview a candidate bundle

Use a new ignored review pin to inspect a complete site **before uploading**.
Offline `build --bundle` checks the ZIP bytes but cannot verify a not-yet-uploaded
asset's GitHub identity. The following recipe deliberately uses placeholder IDs;
it is not an activation pin, a live release claim or publication approval.

Replace the tag and full product commit below with the intended release target
(not the tooling commit). Choose fresh paths to preserve previous review records:

```sh
python3 - .site-output/ballin-gallery-assets-v1.0.0.zip v1.0.0 FULL_PRODUCT_SHA \
  .site-output/offline-review-pin.json <<'PY'
import hashlib, json, re, sys
from pathlib import Path
bundle, tag, commit, output = sys.argv[1:]
if not re.fullmatch(r'[0-9a-f]{40}', commit):
    raise SystemExit('Use the selected full product commit SHA')
path = Path(bundle)
data = path.read_bytes()
pin = {
    'mode': 'release',
    'release': {'id': 1, 'tag': tag, 'commit': commit},
    'asset': {'id': 1, 'name': path.name, 'size': len(data),
              'sha256': hashlib.sha256(data).hexdigest()}
}
with Path(output).open('x') as handle:
    json.dump(pin, handle, indent=2)
    handle.write('\n')
PY
python3 tools/site/site.py build --pin .site-output/offline-review-pin.json \
  --bundle .site-output/ballin-gallery-assets-v1.0.0.zip \
  --output .site-output/candidate-site
python3 tools/site/preview.py --site .site-output/candidate-site
```

For a refresh use the final complete refresh ZIP in both commands. Install the
[site dependencies](../../docs/website.md#build-locally) first, open the printed
loopback URL and follow [Website QA](../../docs/website.md#website-qa). Inspect
`build.json`, the complete gallery, every selected page and matching text, and the
required README fragment. Stop the preview with Control-C. Failed builds preserve
`.site-build-*`; fix the cause and use a new output path.

**Always supply `--bundle` with this offline pin.** Do not use its placeholder IDs
for live retrieval or copy it into `site/bundle.json`. After authorized upload,
replace them with verified real release/asset IDs and recheck tag/commit, name,
size and hash using [Pin and verify](../../docs/website.md#pin-and-verify).

## Upload the reviewed bundle

First verify the actual stable product release/tag/commit, mutability and intended
GitHub account/access under
[the site release-asset procedure](../../docs/website.md#attach-to-the-actual-product-release).
Use an installed GitHub CLI with existing authorized repository access. Resolve
missing login/access with the maintainer; do not change accounts or permissions
automatically. With approval to upload the exact complete ZIP to that release:

```sh
gh release upload v1.0.0 .site-output/ballin-gallery-assets-v1.0.0.zip \
  --repo JBallin/ballin-scripts
```

Use a clear gallery-assets name, including a fresh suffix for replacement output.
Do not use `--clobber`. If the result is uncertain, inspect the actual release and
assets before retrying; do not infer success from a partial log or create a
workaround release. Continue with real-ID retrieval, reviewed pin/README activation
and authorized Pages deployment in
[the ordered runbook](../../docs/website.md#start-to-finish-workflow).
Record the completed steps, exact identities/hashes and next blocked action for
resumption. Do not put raw capture paths or credentials in public handoff records.

## Tool provenance and checks

The workflow reuses the preserved PR #662 scenarios, pure formatters, source
snapshots and PTY verifier, with the AppKit renderer adapted from PR #667 at
`64d48dca63fc8833c366539a487d615dbda45d3f`. Historical fixtures/provenance remain
in `../pr-662-output-gallery`; new builds
record the selected source, exact tool bytes/hashes, dependencies and regeneration
command. Scenarios are maintained for the current stack; review their source
anchors and flow when refreshing. Executable formatter/helper bytes must match
`../pr-662-output-gallery/generation-runtime.json`, reviewed independently of the
candidate. Changed formatters are refused before Node runs; review them and update
those pins as a tooling change. Historical replay keeps its separate original
`trusted-runtime.json` pins. Candidate help and other source remain data. Use
a trusted checkout of the tooling itself.

Run focused checks with `python3 tools/output-gallery/test_gallery.py` for tooling
changes. Documentation-only edits follow the repository's docs-only validation
rule; do not run product flows as a documentation check.
