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
For interactive visual captures, operate the VM through its visible interface
and record the real interaction. SSH remains an option for other testing;
host-side controls must target only the clone.

Record real output with an output-only recorder such as `script -q -t 0`, retaining
the raw ANSI, exact command, prompts/answers, process exit status and downloaded
script checksum. Do not enable key logging. If using Tart folder shares, expose
only dedicated capture inputs (read-only) and generated output, never host HOME or
credentials; clipboard sharing is unnecessary.

### Guest local admin access

The basic installation-testing guide selects the Cirrus Labs Golden Gate vanilla
image. [Tart's image documentation](https://tart.run/quick-start/#vm-images)
publishes username `admin` and password `admin` for its listed Cirrus Labs images;
the [Golden Gate vanilla template](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-golden-gate.pkr.hcl)
also provisions that public default. Check the selected image/tag or digest and
its template history before relying on it. A reused or modified guest may have a
different password; do not assume the default applies to arbitrary images or
versions. Obtain any changed password privately from the template owner or your
trusted credential record.

Use the verified public image default only at the intended **guest** login or
local admin prompt within authorized test work. For a changed or private password,
have the maintainer enter it through a secure private handoff, with recording and
screenshots paused. Do not put private passwords in scripts, command arguments,
environment variables, repository files, logs or chat. Guest admin access is
separate from GitHub authentication and does not sign in to GitHub or authorize
account access.

### Guest command entry

For long commands, use a reviewed script in a dedicated read-only Tart input
share, invoked by a short lowercase command, with a separate disposable results
share. Check the actual guest mount path first; lowercase paths require verified
case-insensitive resolution. For example, with an input share named `inputs`:

```sh
bash /volumes/my\ shared\ files/inputs/run.sh
```

Check guest Terminal focus and a harmless marker before submitting work. Console
entry can lose shifted characters: uppercase can become lowercase, `$` can become
`4`, `_` can become `-`, and `:` can become `;`. Do not assume explicit Shift
combinations or paste prevent this. Inspect the submitted text before treating
unexpected output as a product result. Verify the script's marker/result and exit
status; retain its readable source, revision, hashes and logs. Keep host HOME/credentials unshared and clipboard
sharing disabled, as above.

If using octal `printf` data and shell command substitution as a console fallback,
verify that route in the selected guest first; encoding is not a safety boundary.
Review the decoded command before submission and retain its readable form. A long
encoded input can time out while still composed at the prompt. After a timeout,
inspect the composed text, process/result state and prompt before sending Return,
retrying or claiming cancellation or completion.

### Choose an authentication trust model

Prefer unauthenticated testing when it covers the journey: decline backup setup
and keep GitHub credentials out of the guest. A VM isolates the host, but code
running inside it may use any credentials introduced there, including after
installation. It can replace `gh` or persist other code. A merged commit, `main`,
an immutable SHA, or a successful version check does not establish safety.

For authenticated candidate testing, use only a dedicated minimal-access
disposable GitHub test account with synthetic data, reused across authorized tests.
Do not introduce a personal or maintainer account into a guest that has run
candidate code. The test account's token is available to code running in that
guest; this workflow accepts that exposure and limits what the account can reach.
Give it no organization memberships, production collaborator access, valuable
repositories, unrelated secrets, valuable credentials or payment methods. Start
with no repositories; add a disposable synthetic fixture only when a test needs
one. This limits account exposure, not host, network or VM risks. Authenticating a
clean base first does not protect the account if its clones later run untrusted
code; the clones inherit that exposure. Keep recovery methods and two-factor
authentication outside exposed guests.

Use of a dedicated test account for this workflow has not yet been confirmed as
permitted by GitHub. Treat this account approach as provisional, not as GitHub
approval. Confirm that the intended use is permitted before creating or
authenticating a test account.

Under [GitHub's account requirements](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#3-account-requirements),
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

### Authenticated test base

Use an authenticated base only after confirming that the account and its intended
use are permitted. Apply the
[authentication trust model](#choose-an-authentication-trust-model) above:

1. Keep a separate clean, unauthenticated baseline for genuine first-run tests.
   Prefer unauthenticated clones whenever they cover the required behavior.
2. Once the limited-access test account and its use and access are authorized,
   have the maintainer privately sign into it in one reviewed base VM, with
   recording and screenshots paused. Keep recovery methods and two-factor
   authentication outside exposed test guests.
3. Stop and preserve that base, then use disposable clones for future authorized
   tests with synthetic data only. Clones inherit reusable credentials; a reviewed
   base does not make candidate or untrusted code safe. Do not expose host HOME or
   credentials through shares.
4. When handling suspected exposure or cleaning up credentials, revoke the test
   identity's GitHub CLI authorization remotely from a trusted environment. This
   affects its CLI tokens across devices; local logout or VM deletion is
   insufficient.
   Preserved authenticated snapshots are not fresh credential state. Reassess
   their exposure and obtain separate authorization before fresh authentication.

### Private login launcher

After choosing the trust model above and separately authorizing persistent
GitHub access in that guest, stop all recorders, screen capture and session logging.
In its private interactive Terminal, run
`bash tools/output-gallery/private-login.sh` from a trusted copy of this tooling.
Before probing Git or GitHub CLI, the helper asks you to type `test-account` to
confirm the dedicated account choice and accept guest-token exposure. Press Return
or send EOF to cancel before any tool probes or login. This acknowledgement helps
prevent accidental account use; it cannot enforce account permissions or identity.
The helper checks prerequisites and TTY readiness; it does not verify
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
