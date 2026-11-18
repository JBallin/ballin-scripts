# Preserved PR #662 output gallery

Maintainer review machinery from `/tmp/ballin-662-output-gallery-batch3`, pinned to
Ballin source `5fe81405e0a729eb4af361509015fe932ddc3c75` (review baseline
`866db4ae4c796d5ca3b02caa2398b6222affc61a`). Preserved independently of the release
PR for future work tracked in [#620](https://github.com/JBallin/ballin-scripts/issues/620).

Use Node.js 26 from `.nvmrc`, Python 3, and a POSIX host supporting native PTYs
(the original captures used macOS). No npm packages are needed by the gallery.
From the repository root:

```sh
# Replay preserved source fixtures without running product commands:
bash tools/pr-662-output-gallery/run.command
# Capture/check staged output locally (ignored text/ANSI/report files):
python3 tools/pr-662-output-gallery/verify.py
```

The original preservation commit was
[`c2f09af`](https://github.com/JBallin/ballin-scripts/commit/c2f09af4636cc394adfc69666c6749ed5f91b9bf).
Its temporary branch has been removed after the reusable tooling was carried
forward here. Old generated staged captures are not retained assets; regenerate
current output with the unified workflow below. The current builder targets the
repaired protocol-2 stack. The original PDF/PNG exporter was not included in that
preservation snapshot.

Prefer the unified [local workflow](../output-gallery/README.md) for new current-stack review.
Rendered text/ANSI captures and verification reports are regenerated locally and
ignored by Git; they are not retained source assets.

The launcher also works from another directory. It prints and exits; it does not
open Terminal or read input. The builder writes beside itself; without
`--candidate` it reads the current checkout as an explicitly labeled draft.
The verifier overwrites the four text/ANSI captures and `verification.json`.

`gallery.cjs` stages selected synthetic prompts, answers, paths, errors and
revision identities using copied pure source formatters. `help.json` and
`selection_label.cjs` are extracted fixtures. `source-evidence/`,
`source-anchors.json` and `provenance.json` record the source bytes and hashes.
No stateful product module is loaded. The capture script records this staged
renderer, **not a live installation, backup, update or VM session**; ANSI/text
captures are not screenshots. Excerpt omissions and assumptions remain labeled.

`frozen-provenance.json` retains the original extended validation provenance;
`fidelity-report.md` retains the original source-order review. Rebuilding writes
fresh basic provenance, so those two frozen records remain historical. Product
VM testing belonged to `8d3b1ab785d98e9a7c3e37f662dda891120da71d`, not the final
wording-only candidate. Historical validation claims in those records are not
newly performed product tests. Synthetic destinations and paths contain no user
configuration or credentials.

The original `c2f09af` snapshot made portability changes only: repository-relative builder root, Node.js from PATH,
and a directory-relative launcher. That historical snapshot included no new renderer, app, screenshot system or
public showcase. Current on-demand rendering is documented in the linked workflow. Real installation captures for #620 remain separate
future work under that issue's existing release sequence and constraints.
