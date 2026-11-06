# Local output gallery

Maintainer review tooling for [#620](https://github.com/JBallin/ballin-scripts/issues/620).
On macOS, use Node.js 26 (`.nvmrc`), Python 3 and Xcode command line tools
(Swift/AppKit). No npm dependencies or product execution are needed. From the
repository root:

```sh
python3 tools/output-gallery/run.py --source 1f0c793d7bc6567af7ed2a580ad831c3a1567cc8
cat .output-gallery/1f0c793d7bc6567af7ed2a580ad831c3a1567cc8/staged-02/preview.ansi
open .output-gallery/1f0c793d7bc6567af7ed2a580ad831c3a1567cc8/staged-02/output-001.png
```

Use a full source SHA available in local Git objects. The example selects the
repaired `version-aware-install` stack; refresh it as reviewed product source
changes. These are current-stack review examples, not stable-release documentation
examples. The separately approved v1.0.0 capture/publication sequence is unchanged.

`--output /tmp/ballin-gallery-review` selects another new directory. Existing
output is refused to preserve evidence. Generated assets stay out of Git; the
default `.output-gallery/` is ignored. With approval for the specific files and
destination, attach useful sanitized captures/transcripts to the relevant PR. Failed builds retain a `.gallery-build-*`
directory for diagnosis.

The workflow reuses the preserved PR #662 scenarios, pure formatters, source
snapshots and PTY verifier, with the AppKit renderer adapted from PR #667 at
`64d48dca63fc8833c366539a487d615dbda45d3f`. The update example is unchanged.
Historical fixtures/provenance remain in `../pr-662-output-gallery`; new builds
record the selected source, exact tool bytes/hashes, dependencies and regeneration
command. Scenarios are maintained for the current stack; review their source
anchors and flow when refreshing. Executable formatter/helper bytes must match
`../pr-662-output-gallery/generation-runtime.json`, reviewed independently of the
candidate. Changed formatters are refused before Node runs; review them and update
those pins as a tooling change. Historical replay keeps its separate original
`trusted-runtime.json` pins. Candidate help and other source remain data. Use
a trusted checkout of the tooling itself.

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

The gallery is useful for an agent's visual/interaction review: it groups examples,
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

Keep private authentication outside recording: complete the initial installation
without backup setup, stop the recorder, and let the maintainer log into GitHub
privately. Do not inspect or capture authentication screens, credentials, tokens or
device codes. Resume only after confirmation, within the approved setup/read or
synthetic-backup scope. Record disposable test repository names/URLs and intended
mutations; login alone grants no new mutation authority. Preserve the guest and
captures at handoff, and document cleanup. Delete test repositories only with the
required specific approval; do not remove existing guest data or repositories.

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

Run focused checks with `python3 tools/output-gallery/test_gallery.py`.
