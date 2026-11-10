# Generate experimental package formulas

This generator writes a formula to standard output. It does not install anything,
query the network, create tags or releases, or publish a tap. Run it only with a
trusted local source archive. Its archive reader uses `/usr/bin/tar`; its focused
checks use macOS Ruby for generated-formula syntax validation.

```sh
node experiments/homebrew/generate-formula.cjs \
  --archive /absolute/path/to/ballin-source.tar.gz \
  --sha256 FULL_LOWERCASE_SHA256 \
  --source-sha FULL_LOWERCASE_COMMIT_SHA \
  > /temporary/experiment/tap/Formula/ballin-experiment.rb

node --test experiments/homebrew/generate-formula.test.cjs
```

The archive must have one top-level source directory, with `package.json`,
`.nvmrc`, executable `bin/ballin`, and the complete `commands`, `config` and
`completions` directories, including both `_ballin` and `ballin.bash`. Preserve `config/.defaultConfig.json`. Do not include
an existing `.ballin-package.json`. Symlinks, device entries, duplicate entries
and unsafe archive paths are rejected. The generator checks the archive SHA256,
required runtime members, package identity, installer protocol, version and Node
engine contract. It refuses runtime npm dependencies rather than silently adding
an install step. The formula copies source directly without transpilation. It creates a private
`libexec/completion-node` executable that dispatches to its dependency Node.
Installed completion assets receive a shell-quoted `_ballin_completion_node`
assignment through Ballin's stable `opt_libexec` path, appended after the generated
body while retaining the Zsh `#compdef` first line. It then appends `_ballin_completion_helper` after the runtime assignment, pointing through stable `opt_libexec` to `commands/completion_members.ts`.
This overrides source-time physical-path resolution, so an already-open shell
can find the helper and the active runtime after Brew upgrades and removes the
previous keg/runtime. Re-source completion assets to load changed static definitions. This keeps completion helpers working even when the
keg-only Node dependency is absent from the interactive shell's PATH. Archive
provenance identifies input bytes, not a claim that every installed byte is
unchanged. No shared completion files or shell profiles are written.

The supplied source SHA is an explicit caller assertion, not independently
verified Git provenance. The checksum pins actual archive bytes. A working-tree
archive may include uncommitted changes, so neither that assertion nor the
package's numeric version establishes a release. Every marker generated from caller-supplied local archive input has
`selection.kind: development`, including when package.json says `1.0.0`.

The development marker uses schema 2 with `manager`, `formula: ballin-experiment`, `version`, `sourceRevision`, `selection`,
`archiveSha256`, `commandPath` and `completionRoot`. The last two are computed inside the formula
from its stable `opt_bin` and `opt_libexec` paths. Ballin owns preferences under
`~/.ballin`; Brew owns package source and command links. The formula does not edit
shell startup files, run setup, migrate a Git installation, authenticate, or
capture a backup. Removal retains user state. Existing conflicting command links
must be inspected, not force-overwritten.

After installation, run `ballin setup --initial` for full onboarding.

## Runtime dependency

The formula explicitly requires macOS.

The default is `node@MAJOR` using the archive's `.nvmrc` (currently 26). Formula
availability for that versioned name must be verified in the disposable VM;
generation does not query Homebrew or promise that the formula exists. The
package wrapper executes that dependency's Node with the physical installed
`libexec/bin/ballin` path, without changing the caller's PATH. Optional tools,
including npm maintenance and inventory, therefore keep the caller's selected
environment rather than selecting the package runtime's npm. A package-owned
update launches its internal backup child with the running application's Node
and physical script path even if an integration changes PATH. Direct installs
retain their existing PATH-based child runtime selection. Installation checks
that Node is the selected major and meets the package minimum (currently 24.12.0).

For the existing Node 24 disposable-VM experiment, append `--node-major 24`.
This is an explicit compatibility experiment, not evidence that Node 26 package
installation was tested. Do not install or upgrade host dependencies to validate
it. No Git, GitHub CLI, npm or NVM formula is required by this package; those
features remain optional. No npm packages are installed.

## Verified stable candidate generation

Use the experimental collector with an exact published stable tag, a new absolute
output directory and the exact qualified experimental formula owner:

```sh
node experiments/homebrew/release-provenance.cjs \
  vX.Y.Z /absolute/new/output owner/tap/ballin-experiment
```

It reads fixed upstream GitHub endpoints, verifies published/non-draft/non-prerelease
release identity, peels the tag to a commit, downloads that commit's source archive,
validates its package/runtime contract, then rechecks publication identity. It
refuses redirects, oversized downloads, invalid archives and an existing output
directory. Failed partial output is retained for inspection, never overwritten.
No installation, tap creation, tag, release or publication occurs.

Stable package source must explicitly advertise `ballin.packageSchema: 3` as well
as installer protocol 2. Installer compatibility alone does not establish support
for package metadata: older archives must not receive a marker their code rejects.

The collector writes the downloaded source archive, provenance report and formula.
Stable generation accepts only the collector's in-process verified result. It derives
the commit-addressed archive URL, checksum, version and runtime itself and rehashes
the archive; identity/runtime overrides and replaying a supplied JSON report are
rejected. Offline fixture transports test this contract without claiming a real
release was published or retrieved.

The schema-3 marker adds `selection: {kind: "release", value: "vX.Y.Z", releaseId}`
and `runtime: {nodeMajor, minimumNode}`. Runtime reading validates those fields
against the installed package metadata. Analytics reports the release version and
readiness identifies packaging-time provenance without claiming a new network or
installed-file integrity check. Schemas 1 and 2 retain their previous meanings.

Keep `release:prepare` unchanged. Follow `docs/releasing.md`: review the source,
validate the exact merged SHA, and obtain approval for its version and release notes
before creating a release. Collect/package that verified publication afterward;
the tap recipe and its publication require separate review and authorization.
The current collector's formula remains named `ballin-experiment`, not a published
production package. No custom release asset service is needed.

## Quickstart boundary

Quickstart remains a script and remains unchanged here. Its current selectors
verify published stable releases or resolve explicit development revisions before
setup. Replacing its final installer call with an unqualified `brew install`
would lose exact-selection behavior. The pure `selection-bridge.cjs` gate now compares a resolved release against
validated schema-3 metadata, requiring exact tag, release ID, SHA, version, runtime
and qualified owner. It rejects branch/SHA selectors or an unavailable historical
release rather than substituting latest. This is not yet an executable public
package route. That handoff must bind checked recipe bytes to the installed recipe,
split Git-specific preflight from package preflight, and verify the installed
marker before onboarding. See [the proposal](PROPOSED-RELEASE-DESIGN.md).

For the local chooser, `--formula ballin-local/choice/ballin-experiment` records
that exact owning tap/formula in the marker. The default remains the earlier bare
experimental identity. Modern Homebrew requires formulae inside a tap; the chooser
creates only a guest-local tap and retains its archive there. This does not publish
a tap or make a development marker a release.
