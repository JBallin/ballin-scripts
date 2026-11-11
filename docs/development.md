# Development guide

*Maintainer guide to code layout and changes that must stay synchronized.*

For contributor setup, see [Contributing](../CONTRIBUTING.md). For validation
and isolation requirements, see [Testing and coverage](testing.md).

## Repo map

- `bin/ballin` is the stable, extensionless public entry point and must remain a
  tiny Node shim. Put typed CLI implementations under `commands/` or the feature
  folder that owns them, and configuration code under `config/`.
- Node-side TypeScript runs directly in Node. Do not introduce generated
  JavaScript, build output, runtime transpilers, or bundlers for those surfaces.
  Preserve executable modes and the existing shebang and installed-symlink
  coverage when changing public entry points.
- `install.sh` is Bash bootstrap/install glue, not part of the installed command
  shim. It delegates current setup behavior to `commands/install_setup.ts`.
- `analytics-worker/src/index.ts` is a Cloudflare Workers entry point deployed
  through the existing Wrangler toolchain, not a direct-Node CLI surface. The
  folder also owns D1 migrations, reporting/reset utilities, and deployment
  verification; preserve the isolation and data policy in its README.

## Synchronization points

- When adding or changing public commands, keep dispatch, help, completion,
  documentation, analytics classification, and tests aligned where applicable.
  Backup and config operations share pure command-owned name definitions with
  completion generation. Run `npm run generate:completions` after changing those
  names; tests check the committed shell assets against generated output.
- When installer behavior or invocation changes, update its tests and relevant
  guidance. Keep `README.md` concise; update it when user-facing changes would
  otherwise make its overview, prerequisites, or primary installation instructions
  materially inaccurate or misleading. Put detailed behavior and operational or
  recovery guidance in `docs/installation.md` or the appropriate detailed guide.
  Keep related documentation truthful without requiring mechanical edits to both
  files.
- When configuration defaults or schema change, update
  `config/.defaultConfig.json`, relevant validation and consumers, tests, and the
  owning user documentation. Change `config/updateConfig.ts` only when migration
  behavior itself must change.
- Use the [documentation index](README.md) to find the relevant guide, and use
  that guide's stated audience to judge its abstraction level, detail, and framing. For
  documentation, CLI/help text, and other user-facing copy, apply the relevant
  copy, voice, messaging, terminology, and naming guidance in
  `docs/design-system.md` according to the surface's job and audience. Use Ballin
  for product prose, `ballin` for the executable and command examples, and
  `ballin-scripts` for repository, package, checkout, or path precision.
