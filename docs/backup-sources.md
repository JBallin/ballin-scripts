# Backup sources and sensitivity

`ballin backup` uses an explicit source allowlist. The allowlist limits which
files and command outputs Ballin selects, but it does not make their contents
safe: files and command outputs can contain credentials, private URLs,
usernames, paths, commands, and other sensitive data. This audit records source
sensitivity and repository policy; Ballin does not scan or redact
these snapshots.

Repository capture includes the fixed inventory/preferences baseline and uses
one default-off local `backup.includeSensitive` choice for all sensitive sources.
Existing configured Gists still capture every available catalog source;
`ballin_config` saves only supported preferences. Migration remains separate.

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
| `~/.ballin-scripts/ballin.config.json` | `ballin_config` | Recover supported Ballin preferences. | Five maintenance choices and analytics opt-out. Destination identity, automatic-backup and sensitive-source consent, and custom settings are excluded. | Preferences; filtered export. |
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
guaranteed public-safe or secret-free. Private repository authorization prevents
URL-only access; GitHub and authorized accounts or tokens can still read the
contents.

One local opt-in covers raw configuration and pipx installation metadata.
New and replacement installations start with these sensitive sources off and
make their own choice; approval is never recovered from a backup. Configured
setup retains established local consent; fresh reconnect requires its own
review. This setting does not change existing Gist captures.

Review shows logical paths and resolved targets for selected regular files,
including symlinked dotfiles outside `HOME`. It identifies pipx separately as
installation metadata whose URLs and arguments may contain credentials, without
running its collector or presenting its executable as a raw configuration file.
Review reads no file contents, runs no collectors, and does not recurse. Missing
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
history, or cached content. Existing configured Gists remain readable until
migration and retirement in [#334](https://github.com/JBallin/ballin-scripts/issues/334).

Any new source or group requires an explicit inclusion and sensitivity review.
Unknown groups are excluded; existing or restored preferences do not authorize
them. See [Backup design](backup-design.md#shared-inclusion-policy) and the
[approved #332 contract](https://github.com/JBallin/ballin-scripts/issues/332).
