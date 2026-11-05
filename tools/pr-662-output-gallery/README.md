# Preserved PR #662 output gallery

Maintainer review machinery from `/tmp/ballin-662-output-gallery-batch3`, pinned to
Ballin source `5fe81405e0a729eb4af361509015fe932ddc3c75` (review baseline
`866db4ae4c796d5ca3b02caa2398b6222affc61a`). Preserved independently of the release
PR for future work tracked in [#620](https://github.com/JBallin/ballin-scripts/issues/620).

Use Node.js 26 from `.nvmrc`, Python 3, and a POSIX host supporting native PTYs
(the original captures used macOS). No npm packages are needed by the gallery.
From the repository root:

```sh
bash tools/pr-662-output-gallery/run.command
# Rebuild from local immutable Git objects; no fetch or product execution:
python3 tools/pr-662-output-gallery/build.py --candidate 5fe81405e0a729eb4af361509015fe932ddc3c75
# Capture only the renderer, with plain stdout and normal/NO_COLOR/dumb PTYs:
python3 tools/pr-662-output-gallery/verify.py
```

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

Portability changes only: repository-relative builder root, Node.js from PATH,
and a directory-relative launcher. No new renderer, app, screenshot system or
public showcase is included. Real installation captures for #620 remain separate
future work under that issue's existing release sequence and constraints.
