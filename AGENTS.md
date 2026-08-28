# AGENTS.md

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

## Local commands

- Use the Node.js version from `.nvmrc`.
- Install dependencies with `npm ci`.
- Run `npm test` after changes to code, config, scripts, or tests. Treat
  `package.json` as the source of truth for what that gate includes.
- Add focused validation when a touched risk is not covered by `npm test`;
  `.github/workflows/ci.yml` defines the additional shell and workflow checks.
- For docs-only changes such as README or guide edits, skip local validation
  and rely on CI for automated checks.

## Testing and safety

- Do not exercise Ballin's install, uninstall, update, backup, Homebrew,
  GitHub/Gist, global-package, `softwareupdate`, symlink, Cloudflare/Wrangler,
  D1, deploy, migration, production report/reset, or similar environment-affecting
  behavior against real user or production state.
- Do not manually smoke-test those flows. Representative validation must use
  temporary roots, fixture files, isolated config, complete child-process
  environments, command stubs or fake platform bindings, and existing test
  harness hooks. Reuse existing isolation seams before adding new test-only
  production hooks.

## Synchronization points

- When installer behavior or invocation changes, update its tests and the
  corresponding guidance in `README.md` and `docs/installation.md`.
- When configuration defaults or schema change, update
  `config/.defaultConfig.json`, relevant validation and consumers, tests, and the
  owning user documentation. Change `config/updateConfig.ts` only when migration
  behavior itself must change.
- Use `docs/README.md` to find the owning user or maintainer guide. Follow the
  naming rules in `docs/design-system.md`: Ballin for product prose, `ballin`
  for the executable and command examples, and `ballin-scripts` for repository,
  package, checkout, or path precision.
