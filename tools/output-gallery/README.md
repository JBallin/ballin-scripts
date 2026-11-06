# Local output gallery

Maintainer review tooling for [#620](https://github.com/JBallin/ballin-scripts/issues/620).
On macOS, use Node.js 26 (`.nvmrc`), Python 3 and Xcode command line tools
(Swift/AppKit). No npm dependencies or product execution are needed. From the
repository root:

```sh
python3 tools/output-gallery/run.py --source 4ea163e9197833f83e4a87a9f0b4cfa56e69d8c9
cat .output-gallery/4ea163e9197833f83e4a87a9f0b4cfa56e69d8c9/staged-02/preview.ansi
open .output-gallery/4ea163e9197833f83e4a87a9f0b4cfa56e69d8c9/staged-02/output-001.png
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

Run focused checks with `python3 tools/output-gallery/test_gallery.py`.
