# Backup sources and sensitivity

**Audience:** Users

`ballin backup` uses an explicit source allowlist. The allowlist limits which
files and command outputs Ballin selects, but it does not make their contents
safe: files and command outputs can contain credentials, private URLs,
usernames, paths, commands, and other sensitive data. This audit records source
sensitivity and repository policy; Ballin does not scan or redact
these snapshots.

Repository capture includes the fixed inventory/preferences baseline and uses
one default-off local `backup.includeSensitive` choice for all sensitive sources.
`ballin_config` saves only supported preferences.

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
| Codex `AGENTS.md`, `AGENTS.override.md`, `config.toml`, named `<name>.config.toml`, and `hooks.json` | `codex_AGENTS.md`, `codex_AGENTS.override.md`, `codex_config.toml`, `codex_profiles.json`, `codex_hooks.json` | Preserve instructions, whole configuration/profile files, and executable hook definitions. | Arbitrary commands, MCP inputs, credentials, private paths, and embedded hook/project trust settings. | Sensitive; the same local opt-in. |
| `~/.agents/skills/` | `codex_user_skills.json` | Preserve current shared personal skills recursively. | Arbitrary instructions, executable files, binary assets, credentials, and private project information. | Sensitive; the same local opt-in. |
| Codex `skills/`, `rules/`, and `agents/` | `codex_skills.json`, `codex_rules.json`, `codex_agents.json` | Preserve legacy Codex-home skills and personal rules/agents recursively. | Arbitrary instructions, executable files, binary assets, credentials, and private project information. | Sensitive; the same local opt-in. |
| `~/.agents/plugins/marketplace.json` | `codex_marketplace.json` | Preserve the personal plugin marketplace definition. | Plugin references, private paths, URLs, and arbitrary manifest values. | Sensitive; the same local opt-in; referenced payloads excluded. |
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

## Repository inclusion

Backup remains optional. Private-repository backups include the fixed
inventory baseline and supported Ballin preferences by default. Inventories
may contain private tool choices, identities, paths, and URLs; they are not
guaranteed public-safe or secret-free. Backups are stored in a private GitHub
repository. GitHub and anyone authorized to access the repository can read its
contents.

The single `backup.includeSensitive` setting controls **sensitive sources**:
raw shell/Git/editor/Codex configuration, `.nvmrc`, and pipx installation metadata.
New and replacement installations start with these sensitive sources off and
make their own choice; approval is never recovered from a backup. Configured
setup retains established local consent; fresh reconnect requires its own
review. The choice covers current and future supported sensitive sources,
including Codex for existing opt-ins. Setup discloses this scope; source changes
are documented in the source guide and release/update guidance.

Review shows logical paths and resolved targets for selected regular files,
including symlinked dotfiles outside `HOME`. It identifies pipx separately as
installation metadata whose URLs and arguments may contain credentials, without
running its collector or presenting its executable as a raw configuration file.
Review reads no file contents and runs no collectors. Codex directory discovery
recursively inspects names and file types to identify nonempty sources. Missing
and unavailable sources are shown; access or resolution errors prevent
confirmation. EOF or declining final confirmation cancels without
saving consent or changing destination, cache, or remote state. Excluded
sensitive sources are not inspected just to verify them.

Consent covers later captures as files, symlink targets, and installed-tool
metadata change. It does not certify future contents or require repeated review
during unattended backups. Deliberately selected content remains intact without
redaction, subject to the existing final-newline and empty-file normalization;
snapshots do not preserve filesystem bytes and metadata exactly. Known
credential stores, authentication/session files, SSH private keys, and arbitrary
home trees remain outside direct selection. Allowed sources may still contain
credentials.

Omitting a category from future captures does not delete older remote files,
history, or cached content.

## Codex configuration

Ballin uses the active `CODEX_HOME` when set, otherwise `~/.codex`. Personal
skills at `~/.agents/skills/` and marketplace configuration are selected
separately at fixed home paths, independent of `CODEX_HOME`.
`codex_skills.json` retains the legacy `CODEX_HOME/skills/` location for
compatibility; `codex_user_skills.json` captures the current shared personal root.
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
relative paths, base64 bytes, and an executable flag. Hidden files and binary
assets are included; empty directories, symlinks, special files, `.git` metadata,
and `.DS_Store` are omitted. Both skill sources omit root `.system`. Codex
source paths reject descendant symlinks; an explicitly selected Codex root may
be a symlink. Empty or generated-only directory sources are not published.
Review opens and closes selected regular files to check readability without
reading their contents. Capture is not an atomic snapshot of concurrent edits.
See [directory handling](backup-design.md#shared-inclusion-policy).

Codex capture supports up to **16 MiB combined** per backup after normalization,
including archive metadata and base64 content, and **8,192 visited entries** per
recursive source. Both skill archives count toward the combined limit, even
when their roots overlap. Exceeding a limit stops the whole backup before publication or cache promotion. Ballin does not truncate
files or selectively omit content to fit. Reduce the supported authoring-tree
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
