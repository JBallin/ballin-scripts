# Backup sources and sensitivity

*User guide to Ballin snapshot sources, captured files, and data sensitivity considerations.*

## What will Ballin back up?

Backups are optional. By default, a backup includes allowlisted tool inventories
and filtered Ballin preferences. These can contain private tool choices,
identities, paths, URLs, or secrets. Backups are stored in a private GitHub
repository; GitHub and anyone
with authorized repository access can read them.

Sensitive sources are off by default on a new installation. The local
`backup.includeSensitive` choice adds all currently supported sensitive sources
and future additions: raw shell/Git/editor configuration, Codex and Claude Code
configuration and authoring files, `.nvmrc`, and pipx installation metadata.
Eligible skill packages can include hidden files, executable scripts, and binary
assets. Synced Claude skills include only plugin-origin packages selected by
local manifests; defaults and other origins are excluded even if edited.

Ballin does not scan or redact credentials. It does not automatically restore
sensitive content or execute saved definitions. Excluding a source from future
backups does not remove previously saved files, history, or cached content.

See the [source catalog](#source-catalog) for captured files and commands,
[Codex configuration](#codex-configuration) and
[Claude Code configuration](#claude-code-configuration) for their detailed
boundaries, and [repository inclusion](#repository-inclusion) for source review
and consent persistence.

## Repository inclusion

New and replacement installations start with these sensitive sources off and
make their own choice; approval is never recovered from a backup. Configured
setup retains established local consent; fresh reconnect requires its own
review. Source changes are documented here and in release/update guidance.

Ballin previews logical paths and resolved targets for selected regular files,
including symlinked dotfiles outside `HOME`. It identifies pipx separately as
installation metadata whose URLs and arguments may contain credentials, without
running its collector or presenting its executable as a raw configuration file.
For synced Claude skills, Ballin reads bounded local collection manifests to
select plugin packages. It checks selected file readability without reading
their contents or creating backup snapshots. Codex and Claude Code directory
discovery recursively inspects names and file types to identify
nonempty sources. Missing and unavailable sources are shown; access or
resolution errors prevent confirmation. Closing input or declining final
confirmation cancels without saving consent or changing destination, cache, or
remote state. Excluded
sensitive sources are not inspected just to verify them.

Consent covers later captures as files, symlink targets, and installed-tool
metadata change. It does not certify future contents or require repeated review
during unattended backups. Deliberately selected content remains intact without
redaction, subject to the existing final-newline and empty-file normalization;
snapshots do not preserve filesystem bytes and metadata exactly. Known
credential stores, authentication/session files, SSH private keys, and arbitrary
home trees remain outside direct selection. Allowed sources may still contain
credentials.

## Source catalog

Listed filenames may live under an application's configuration directory. To
inspect editor files before enabling backup or sharing snapshots, check
`~/Library/Application Support/Code/User/` and
`~/Library/Application Support/Code - Insiders/User/`.

| Local source or command | Snapshot | Why included | Plausible sensitive content | Repository policy |
| --- | --- | --- | --- | --- |
| `.bash_profile`, `.bashrc`, `.profile`, `.zprofile`, `.zshrc` | `bash_profile.sh`, `bashrc.sh`, `profile.sh`, `zprofile.sh`, `zshrc.sh` | Reproduce shell startup behavior. | Arbitrary exports, tokens, URLs, usernames, paths, and shell commands. | Sensitive; one local opt-in. |
| `.gitconfig`, `.gitignore_global` | `gitconfig`, `gitignore_global` | Preserve Git identity, behavior, and global ignore preferences. | Identity, signing configuration, credential helpers, token-bearing rewrites, private URLs, and project patterns. | Sensitive; one local opt-in. |
| `.vimrc`, `.nanorc` | `vimrc`, `nanorc` | Preserve editor behavior. | Arbitrary user commands, paths, plugins, and URLs. | Sensitive; one local opt-in. |
| VS Code and VS Code Insiders `settings.json`, `keybindings.json` | `vs_settings`, `vs_keybindings`, `vsI_settings`, `vsI_keybindings` | Preserve editor settings and keybindings. | Extension credentials, remote hosts, paths, command arguments, and arbitrary settings. | Sensitive; one local opt-in. |
| `code --list-extensions`, `code-insiders --list-extensions` | `vs_extensions`, `vsI_extensions` | Record installed editor tooling. | Tool choices, employers or projects, and user preferences. | Inventory; default included. |
| `~/.ballin-scripts/ballin.config.json` | `ballin_config` | Recover supported Ballin preferences. | Supported Ballin preferences. The backup destination, analytics setting and install ID, automatic-backup setting, sensitive-source consent, and custom settings are excluded. | Preferences; filtered export. |
| Codex `AGENTS.md`, `AGENTS.override.md`, `config.toml`, named `<name>.config.toml`, and `hooks.json` | `codex_AGENTS.md`, `codex_AGENTS.override.md`, `codex_config.toml`, `codex_profiles.bundle.json`, `codex_hooks.json` | Preserve instructions, whole configuration/profile files, and executable hook definitions. | Arbitrary commands, MCP inputs, credentials, private paths, and embedded hook/project trust settings. | Sensitive; the same local opt-in. |
| `~/.agents/skills/` | `codex_user_skills.bundle.json` | Preserve current shared personal skills recursively. | Arbitrary instructions, executable files, binary assets, credentials, and private project information. | Sensitive; the same local opt-in. |
| Codex `skills/`, `rules/`, and `agents/` | `codex_skills.bundle.json`, `codex_rules.bundle.json`, `codex_agents.bundle.json` | Preserve legacy Codex-home skills and personal rules/agents recursively. | Arbitrary instructions, executable files, binary assets, credentials, and private project information. | Sensitive; the same local opt-in. |
| `~/.agents/plugins/marketplace.json` | `codex_marketplace.json` | Preserve the personal plugin marketplace definition. | Plugin references, private paths, URLs, and arbitrary manifest values. | Sensitive; the same local opt-in; referenced payloads excluded. |
| Claude Code `CLAUDE.md` | `claude_instructions` | Preserve personal instructions from the active configuration root. | Private instructions, credentials, paths, and imported-file references. | Sensitive; the same local opt-in; imports are not collected. |
| Claude Code `rules/`, `agents/`, and legacy `commands/` | `claude_rules.bundle.json`, `claude_agents.bundle.json`, `claude_commands.bundle.json` | Preserve regular Markdown configuration recursively. | Private instructions, inline MCP values, permission modes, hook definitions, commands, and credentials. | Sensitive; the same local opt-in; referenced resources excluded. |
| Claude Code `skills/` | `claude_skills.bundle.json` | Preserve complete eligible personal folders and plugin-origin synced packages, including hidden support, scripts, and binary assets. | Arbitrary instructions, credentials, executable files, private project information, and collection identifiers. | Sensitive; the same local opt-in; other synced origins, sync bookkeeping, plugin installations, and external references excluded. |
| Active Homebrew completion directory listing | `bash_completions` | Record installed completion names. | Installed-tool names. | Inventory; default included. |
| `brew list --formula`, `brew leaves`, `brew list --cask` | `brew_list`, `brew_leaves`, `brew_cask` | Record Homebrew inventory. | Installed tools and applications, including organizational preferences. | Inventory; default included. |
| `brew services list` | `brew_services` | Record managed service state. | Services, status, usernames, and launch paths. | Inventory; default included. |
| `brew bundle dump --file=-` | `Brewfile` | Generate an installed-state reference inventory. | Taps, packages, applications, and potentially private or custom source URLs. | Inventory; default included. |
| `npm list -g --depth=0` | `npm_global` | Record global npm tools. | Package names, versions, private scopes, and local paths. | Inventory; default included. |
| `uv tool list ...` | `uv_tools` | Record installed tools and requested requirements. | Private requirements, URLs, extras, and tool choices. | Inventory; default included. |
| `pyenv versions --bare` | `pyenv_versions` | Record installed Python runtimes and environments. | Environment names may identify private projects. | Inventory; default included. |
| `pipx list --json` | `pipx` | Record Python tool installation metadata. | Original install URLs, backend arguments that may contain credentials, and local paths. | Sensitive; the same local opt-in as raw files. |
| `.nvmrc` | `nvmrc` | Preserve the preferred Node.js version. | Usually a version, but the file is arbitrary user-authored content. | Sensitive; one local opt-in. |
| `mas list` | `mas` | Record installed Mac App Store applications. | Application choices and versions. | Inventory; default included. |

## Codex configuration

Ballin uses the active `CODEX_HOME` when set, otherwise `~/.codex`. Personal
skills at `~/.agents/skills/` and marketplace configuration are selected
separately at fixed home paths, independent of `CODEX_HOME`.
`codex_skills.bundle.json` retains the legacy `CODEX_HOME/skills/` location for
compatibility; `codex_user_skills.bundle.json` captures the current shared personal root.
Project `.codex/` directories are repository-owned and are not global sources.
Both global instruction files, `AGENTS.md` and `AGENTS.override.md`, are backed
up separately when present, regardless of which Codex currently uses.

A discovery failure for a selected Codex source stops the backup before staging;
Ballin does not publish a partial capture. Absent or policy-excluded sources
remain skipped.

Whole configuration files preserve instructions, inline hooks, workflow
preferences, and embedded project trust levels or hook approval hashes. Ballin
does not filter those values, replay approvals, execute hooks, or automatically
restore configuration. Review configuration before manually using a backup;
manual restoration can carry forward saved trust settings. Standalone
`hooks.json` preserves definitions only; referenced scripts, tools, MCP servers,
and external files are not collected merely because they are referenced.

Recursive snapshots are versioned JSON archives of regular files, with sorted
relative paths, readable UTF-8 lines or Base64 bytes, and an executable flag.
Hidden files and binary
assets are included; empty directories, symlinks, special files, `.git` metadata,
and `.DS_Store` are omitted. Both skill sources omit root `.system`. Codex
source paths reject descendant symlinks; an explicitly selected Codex root may
be a symlink. Empty or generated-only directory sources are not published.
Review opens and closes selected regular files to check readability without
reading their contents. Capture is not an atomic snapshot of concurrent edits.
See [directory handling](backup-design.md#shared-inclusion-policy).

Codex capture supports up to **16 MiB combined** per backup after normalization,
including archive metadata and text/Base64 encoding overhead, and **8,192 visited
entries** per
recursive source. Both skill archives count toward the combined limit, even
when their roots overlap. Exceeding a limit stops the whole backup before
publication or cache promotion. Ballin does not truncate files or selectively omit content to fit. Reduce the supported authoring-tree
size or turn off sensitive sources before retrying. Existing remote snapshots
remain retained; these limits do not bound repository size or total memory
used to inspect historical remote content.

Ballin does not select authentication files, sessions/history, caches, logs,
worktrees, databases, memory/runtime state, or separate trust stores. The entire
`plugins/` tree remains excluded because its authoring payloads and generated
installation/cache state are not one reliably bounded source; the personal
marketplace manifest preserves references, not plugin content. These exclusions
are source boundaries, not a scan for secrets within approved authoring files.
Desktop-only settings without independently identified durable storage remain
outside capture. Deprecated `CODEX_HOME/prompts/` is excluded.

New supported sources undergo repository inclusion and sensitivity review;
unknown groups remain excluded. See
[Backup design](backup-design.md#shared-inclusion-policy).

## Claude Code configuration

Ballin uses `CLAUDE_CONFIG_DIR` when nonempty, otherwise `~/.claude`. Relative
root overrides resolve from the command's working directory; an explicitly
selected root may be an alias. It selects `CLAUDE.md` and regular `.md`
files beneath personal `rules/`, `agents/`, and legacy `commands/` directories.
Personal and synced skills are selected separately as described below. A selected
path identifies a supported configuration location, not proof of authorship or
secret-free contents. [Claude skills](https://code.claude.com/docs/en/skills)
are the preferred surface for new custom capabilities; `commands/` preserves
existing compatibility files.

Bundle snapshots use the same versioned JSON archive as Codex, preserving
relative paths, exact file bytes, and executable flags. The Markdown sources
omit non-Markdown files. All Claude sources omit symlinks, special files, empty
directories, `.git`, and `.DS_Store`.
Selected hard links stop capture; Ballin does not search for their other paths.
During discovery and preview, Ballin checks file attributes and reads bounded
local collection manifests to select synced plugin packages. The preview checks
readability without reading selected file contents or creating backup snapshots.
Discovery or collection failure stops the backup before publication. Capture is
not atomic across concurrent edits.

Claude Code has its own **16 MiB combined** normalized capture allowance,
including unchanged snapshots and archive/encoding overhead, plus **8,192 visited
entries** per directory source, counted before filtering. This preserves the
existing Codex allowance, permitting up to 32 MiB combined staged assistant
configuration. Limits stop the whole backup without truncation or partial
publication; they do not bound historical remote reads or total process memory.

Raw user settings and `.claude.json` are excluded. Settings mix preferences with
environment values, credential helpers, permissions, sandbox exceptions, hooks,
and plugin configuration; `.claude.json` mixes MCP definitions with sign-in and
project trust state. Claude documents that `.claude.json` moves inside
`CLAUDE_CONFIG_DIR` when set; neither location is selected. See
[settings](https://code.claude.com/docs/en/settings) and
[MCP locations](https://code.claude.com/docs/en/mcp-quickstart#find-your-configuration-on-disk).
Plugin and marketplace intent needs a separate settings decision; fetched
`plugins/` content is excluded. Hooks in excluded settings are not captured,
while hooks embedded in selected agent Markdown remain intact. Ballin never
executes definitions, follows external references, or restores approvals.

Personal skills capture immediate nonhidden folders in `skills/` that contain
an exact-case regular `SKILL.md`. Their complete regular-file contents are
preserved recursively, including hidden files, executable scripts, and binary
assets. Loose root files and folders without that marker are omitted. Root
`anthropic-skills` and `anthropic-skills:*` names are excluded without
regard to case, as are hidden root folders such as `.trash` and `.system`.

Synced packages are also selected at `skills/synced/<collection>/<skill>/` when
they contain an exact-case regular `SKILL.md`. Collection names are not restricted
to UUIDs, and all collections present on disk are considered. A synced package
also requires a unique matching name in its collection's `manifest.json` with
exact `source: "plugin"`. Other source values, including `anthropic`,
`anthropic-example`, unknown values, and unlisted packages, are omitted.
There is no skill-name allowlist or guessed mapping between names and origins.
Their complete regular-file contents follow the same rules as personal skills;
hidden package/support names are preserved. Stored member paths use
`<skill>/SKILL.md` and `<skill>/<supporting-file>`, omitting the `synced/` and
collection directory prefix. Personal skill paths keep their existing layout.
If eligible packages in different collections or a personal folder share a
skill directory name, the whole skills source is unavailable and its previous
saved bundle is retained. Packages are never merged or deduplicated, even when
their contents match.

Existing version-2 bundles with namespaced paths remain readable by their saved
paths. The first successful normalized capture changes stored paths through the
ordinary byte-based backup comparison; it does not rewrite existing history or
bypass conflicts when a trusted comparison base is missing. Sync-directory
changes alone no longer change an otherwise identical capture. File contents,
including any paths or references inside them, are preserved unchanged.

Loose files in sync containers are omitted. `manifest.json`, `.staging`,
`.last-complete-round`, and `.trash` entries at the synced root or collection
level are excluded from capture without regard to case or type. Collection
manifests are read only to select packages, using the observed on-disk metadata
shape; the Claude skills documentation does not define this shape as a public
API. Selection fields (`skills`, `name`, and `source`) must not repeat within
their objects, including escaped spellings of those keys. Names must be
unambiguous single folder names and are never followed as
paths. Across the skills source, manifest reads are bounded to 1 MiB and 8,192
records, separate from the existing capture limits. Missing, unreadable,
malformed, oversized, symlinked, hard-linked, or ambiguously named manifests make
the whole skills source unavailable, retaining its previous saved bundle rather
than publishing a partial capture. Ballin reads the collection manifests during
discovery and preview; it does not read skill contents or traverse omitted
payloads at those stages.

The plugin origin does not prove personal authorship: third-party or
organization-provided plugin-origin packages can qualify. Other origins are
excluded even when locally edited; Ballin does not detect edited defaults.
Sync can overwrite local edits, so resynchronization is not a promise of exact recovery.
See [Claude's sync behavior](https://code.claude.com/docs/en/skills#where-synced-skills-load).

An immediate `.claude-plugin` entry excludes the whole skill folder, regardless
of its type or capitalization. A root `manifest.json` entry, regardless of type
or capitalization, makes the skills source unavailable; Ballin does not read it
to distinguish legacy downloads from personal folders. Unavailable sources retain
any existing saved snapshot. See [Claude skills](https://code.claude.com/docs/en/skills).

These rules identify eligible packages, not proven authorship. Eligible folders
can contain downloaded or copied third-party material, and selected visible or hidden files
can contain credentials or private environment values. Ballin does not scan or
redact them. Dedicated credential stores, generated memory, sessions, histories,
caches, logs, and runtime state outside the selected packages remain
unselected. Excluding sources does not delete previously saved
files or history.

Project `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/` configuration, and
`.mcp.json` remain project-owned; Ballin does not crawl repositories. Claude's
project `AGENTS.md` support depends on its version and instruction settings; see
[project instructions](https://code.claude.com/docs/en/memory).

## Last successful backup

Before collecting sources, Ballin shows `Last successful backup:` with the
last recorded successful run's local date, time and UTC offset for this
installation, destination and branch. With no usable record, the line is omitted.
For an already-configured destination, `ballin backup setup` also shows the
record or unavailable status. Setup and recovery do not invent a previous time.

Changed and unchanged successful runs update the local record; failed attempts
do not. An unchanged run creates no repository commit just to record activity.
If saving the time fails, Ballin reports an advisory while preserving backup
success and the prior record. This time does not prove that every source was
captured, that the repository matches your Mac now, or that the backup is fresh.
