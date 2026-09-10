# Backup sources and sensitivity

`ballin backup` uses an explicit source allowlist. The allowlist limits which
files and command outputs Ballin selects, but it does not make their contents
safe: allowed user-authored files can contain arbitrary secrets, credentials,
private URLs, usernames, paths, commands, and other sensitive data. This audit
records source sensitivity and the shared reviewed policy; Ballin does not
scan or redact these snapshots.

Current Gist capture still includes every available catalog source;
`ballin_config` now exports only portable preferences. The category selection
and review described below are prepared for future repository onboarding in
[#333](https://github.com/JBallin/ballin-scripts/issues/333) and migration in
[#334](https://github.com/JBallin/ballin-scripts/issues/334). They are not part of
current Gist setup and do not restrict Gist captures.

Listed filenames may live under an application's configuration directory. To
inspect editor files before enabling Gist backup or sharing snapshots, check
`~/Library/Application Support/Code/User/` and
`~/Library/Application Support/Code - Insiders/User/`.

| Local source or command | Snapshot | Why included | Plausible sensitive content | Shared reviewed policy |
| --- | --- | --- | --- | --- |
| `.bash_profile`, `.bashrc`, `.profile`, `.zprofile`, `.zshrc` | `bash_profile.sh`, `bashrc.sh`, `profile.sh`, `zprofile.sh`, `zshrc.sh` | Reproduce shell startup behavior. | Arbitrary exports, tokens, URLs, usernames, paths, and shell commands. | Raw; explicit opt-in. |
| `.gitconfig`, `.gitignore_global` | `gitconfig`, `gitignore_global` | Preserve Git identity, behavior, and global ignore preferences. | Identity, signing configuration, credential helpers, token-bearing rewrites, private URLs, and project patterns. | Raw; explicit opt-in. |
| `.vimrc`, `.nanorc` | `vimrc`, `nanorc` | Preserve editor behavior. | Arbitrary user commands, paths, plugins, and URLs. | Raw; explicit opt-in. |
| VS Code and VS Code Insiders `settings.json`, `keybindings.json` | `vs_settings`, `vs_keybindings`, `vsI_settings`, `vsI_keybindings` | Preserve editor settings and keybindings. | Extension credentials, remote hosts, paths, command arguments, and arbitrary settings. | Raw; explicit opt-in. |
| `code --list-extensions`, `code-insiders --list-extensions` | `vs_extensions`, `vsI_extensions` | Record installed editor tooling. | Tool choices, employers or projects, and user preferences. | Inventory; default included. |
| `~/.ballin-scripts/ballin.config.json` | `ballin_config` | Preserve explicitly portable preferences. | Update/inclusion choices and analytics opt-out. Destination and unknown/custom fields are excluded. | Preferences; projected export. |
| Active Homebrew completion directory listing | `bash_completions` | Record installed completion names. | Installed-tool names. | Inventory; default included. |
| `brew list --formula`, `brew leaves`, `brew list --cask` | `brew_list`, `brew_leaves`, `brew_cask` | Record Homebrew inventory. | Installed tools and applications, including organizational preferences. | Inventory; default included. |
| `brew services list` | `brew_services` | Record managed service state. | Services, status, usernames, and launch paths. | Detailed; explicit opt-in. |
| `brew bundle dump --file=-` | `Brewfile` | Produce a portable reference inventory. | Taps, packages, applications, and potentially private or custom source URLs. | Detailed; explicit opt-in. |
| `npm list -g --depth=0`, `pipx list --json`, `uv tool list ...`, `pyenv versions --bare` | `npm_global`, `pipx`, `uv_tools`, `pyenv_versions` | Record globally installed language tools and runtimes. | Package names, versions, environment names, private scopes or URLs, and local paths. | Detailed; explicit opt-in. |
| `.nvmrc` | `nvmrc` | Preserve the preferred Node.js version. | Usually a version, but the file is arbitrary user-authored content. | Raw; explicit opt-in. |
| `mas list` | `mas` | Record installed Mac App Store applications. | Application choices and versions. | Inventory; default included. |

## Shared inclusion policy

Backup remains optional. For destinations using the shared policy, the default
is the lower-sensitivity inventory group plus projected Ballin preferences.
Inventory can reveal organizational preferences and is not guaranteed
public-safe or secret-free.

`backup.includeRaw` and `backup.includeDetailed` each default to `"false"`.
The shared review asks about them separately, shows the selected categories,
and requires final confirmation. A remotely restored true is a proposal with
a default-no choice; existing local choices are preserved as review defaults.
Declining final confirmation or reaching EOF cancels without saving choices.
See [portable preferences](optional-capabilities.md#portable-preferences) for
the exact export, restoration, and local-precedence rules.

Raw review shows logical paths and resolved targets for selected regular files,
including normal symlinked dotfiles outside `HOME`. It reads no file contents
and traverses no directory trees. Missing and unavailable sources are shown;
discovery or resolution errors prevent confirmation. Excluded raw sources are
not inspected just to verify them.

Inclusion authorizes future captures as files and symlink targets change; it
does not certify future contents. Deliberately selected raw content is kept
without redaction. Snapshots still use the existing final-newline and empty-file
normalization, rather than preserving filesystem bytes and metadata exactly.
Ordinary private configuration can be selected when the user accepts the
destination's access boundary. Credential stores, authentication/session files,
SSH private keys, and arbitrary home trees are not added to the source list.
Allowed files may still contain credentials; Ballin does not scan or redact
them.

Omitting a category from future captures does not delete older remote files,
history, or cached content. Current Gist read/recovery remains available.

Any new snapshot category requires an explicit inclusion and sensitivity review
before it is added to Ballin's backup source allowlist. New inclusion categories
require a default-off decision; existing or restored flags cannot silently
authorize them.
