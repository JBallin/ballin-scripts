# Local output gallery

Maintainer tooling for [#620](https://github.com/JBallin/ballin-scripts/issues/620).
Generate on demand on macOS with Node.js 26 (`.nvmrc`), Python 3, and the Xcode
command line tools (Swift/AppKit). No npm dependencies or product commands are
needed for generation. Run from the repository root:

```sh
python3 tools/output-gallery/run.py --source b801649dbcd878e2bd66fee50eba85446323df6b
cat .output-gallery/b801649dbcd878e2bd66fee50eba85446323df6b/staged-02/preview.ansi
open .output-gallery/b801649dbcd878e2bd66fee50eba85446323df6b/staged-02/output-001.png
```

The full immutable source SHA must exist in local Git objects. This initial
source is the repaired product stack on `version-aware-install`, not a stable
release. Refresh with the reviewed branch head when that product source changes. Do not use these captures
as stable v1.0.0 README/Quickstart examples; their separately approved release and
capture sequence remains unchanged.

`--output /tmp/ballin-gallery-review` chooses a new destination. Existing output
is refused so earlier evidence remains intact; choose another directory for a
refresh. Outputs inside the checkout must be Git-ignored. `.output-gallery/` is
ignored. Do not commit images, transcripts, compiler caches or generated copies.
A failed build remains in a `.gallery-build-*` directory for diagnosis, without
being labeled as a completed gallery.

The entrypoint adapts the preserved PR #662 generator, scenarios, immutable source
snapshots, source anchors and PTY verifier. Historical fixtures remain under
`../pr-662-output-gallery`; their frozen provenance is historical. Newly generated
provenance identifies the selected current source. Only copied pure formatters
and extracted display expressions are loaded; setup/install/update/backup modules
are never executed. Scenarios are maintained for the current stack, with source
anchors that fail on stale assumptions. They are not a universal compatibility
framework. Review anchors and scenario flow whenever changing source revisions.

Each scenario retains raw ANSI, a labeled Terminal preview, matching `text.txt`,
paginated PNGs and provenance with file hashes. The Swift renderer is adapted from
PR #667 at `64d48dca63fc8833c366539a487d615dbda45d3f`; the update example itself is
unchanged. It preserves bold, underline and the eight ANSI foreground colors,
wraps long lines within image margins and paginates at readable 16-point type.
Unsupported styles or terminal controls fail visibly instead of disappearing.
Its extracted logical text must exactly match `text.txt`; visual wrapping does
not insert newlines into accessible text. Images are rendered representations,
not native Terminal screenshots. Use the same scenario's preview, PNG pages and
text together to assess wording, flow, color, spacing, wrapping and fidelity.
Presentation checks do not establish successful end-to-end execution.

## Actual disposable VM captures

VM use requires coordination and the repository's installation-testing safeguards.
Never run environment-affecting commands on the host. Preserve existing guests;
use fresh disposable state. Do not authenticate or create backups without their
separate authorization and disposable data. Retain meaningful prompts, answers,
results and original output. Exclude credentials, device codes, private backup
names and personal data before retaining evidence. Do not replace failures with
staged success. Current-stack review captures remain distinct from final release
examples.

Import reviewed recordings with `--captures /path/to/manifest.json`. This is an
importer, not a VM runner: it executes no manifest command. Example schema:

```json
{
  "captures": [{
    "id": "direct-install",
    "kind": "actual-vm",
    "sourceRevision": "FULL_40_CHARACTER_COMMIT_SHA",
    "raw": "direct-install.ansi",
    "rawSha256": "SHA256_OF_RETAINED_SANITIZED_BYTES",
    "command": "exact command run in the disposable guest",
    "answers": ["actual ordered prompt and answer records"],
    "result": {"exitCode": 0, "summary": "observed result"},
    "environment": {"vm": "disposable identifier", "initialState": "prerequisites and guest provenance"},
    "edits": "None; or disclose exact redactions/omissions and retained safe original",
    "sensitiveDataReviewed": true
  }]
}
```

`raw` resolves relative to the manifest. The hash must match its retained bytes.
Source must match `--source`. ANSI imports support SGR styles and LF/CRLF; tabs,
redraw controls, cursor movement and other controls are refused. If a recording
requires tab expansion, terminal emulation or editing, retain its safe original separately and
explicitly describe normalization and omissions in `edits`. An import declaration
is provenance supplied by the maintainer; the importer cannot independently
prove that execution occurred. It never substitutes synthetic content for a
missing live capture.

The manifest records exact source, tooling hashes/head, dependency versions,
scenario classification, regeneration command and capture declarations. Keep the
input manifest and retained sanitized recordings with the local output so a
refresh can import them. For staged scenarios, source snapshots and generator
inputs are retained in `staged/`; the repository retains generator source and
historical fixtures. Real direct installation (prerequisites present), Quickstart
(no Homebrew), and core-command VM coverage must be reported individually;
absent captures are pending, not passed.

Run focused renderer/fidelity checks with `python3 tools/output-gallery/test_gallery.py`.
