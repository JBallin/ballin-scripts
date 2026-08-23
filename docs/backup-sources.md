# Backup sources and sensitivity

`ballin backup` uses an explicit source allowlist. The allowlist limits which
files and command outputs Ballin selects, but it does not make their contents
safe: allowed user-authored files can contain arbitrary secrets, credentials,
private URLs, usernames, paths, commands, and other sensitive data. This audit
records the current inclusion decision; Ballin does not scan or redact these
snapshots.

Listed filenames may live under an application's configuration directory. To
inspect editor files before opting in, check
`~/Library/Application Support/Code/User/`,
`~/Library/Application Support/Code - Insiders/User/`, and
`~/Library/Application Support/Brackets/`.

| Local source or command | Gist snapshot | Why included | Plausible sensitive content | Decision |
| --- | --- | --- | --- | --- |
| `.bash_profile`, `.bashrc`, `.profile`, `.zprofile`, `.zshrc` | `bash_profile.sh`, `bashrc.sh`, `profile.sh`, `zprofile.sh`, `zshrc.sh` | Reproduce shell startup behavior. | Arbitrary exports, tokens, URLs, usernames, paths, and shell commands. | Retain; warn prominently, with no heuristic redaction. |
| `.gitconfig`, `.gitignore_global` | `gitconfig`, `gitignore_global` | Preserve Git identity, behavior, and global ignore preferences. | Identity, signing configuration, credential helpers, token-bearing rewrites, private URLs, and project patterns. | Retain; explicitly identify as sensitive. |
| `.vimrc`, `.nanorc` | `vimrc`, `nanorc` | Preserve editor behavior. | Arbitrary user commands, paths, plugins, and URLs. | Retain; document. |
| VS Code and VS Code Insiders `settings.json`, `keybindings.json` | `vs_settings`, `vs_keybindings`, `vsI_settings`, `vsI_keybindings` | Preserve editor settings and keybindings. | Extension credentials, remote hosts, paths, command arguments, and arbitrary settings. | Retain; explicitly identify as sensitive. |
| `code --list-extensions`, `code-insiders --list-extensions` | `vs_extensions`, `vsI_extensions` | Record installed editor tooling. | Tool choices, employers or projects, and user preferences. | Retain; document metadata exposure. |
| Brackets `brackets.json`, `keymap.json` | `brackets_settings.json`, `brackets_keymap.json` | Preserve editor settings and keybindings. | Arbitrary extension configuration, paths, and possible credentials. | Retain; explicitly identify as sensitive. |
| Brackets user and disabled extension directory listings | `brackets_extensions`, `brackets_disabled_extensions` | Record installed and disabled tooling. | Tooling and preferences. | Retain; document metadata exposure. |
| `~/.ballin-scripts/ballin.config.json` | `ballin_config` | Preserve compatible Ballin preferences for adoption. | Gist ID and host, update choices, analytics choice, and unknown future settings. | Retain for adoption compatibility; setup overrides destination fields during adoption. |
| Active Homebrew completion directory listing | `bash_completions` | Record installed completion names. | Installed-tool names. | Retain. |
| `brew list --formula`, `brew leaves`, `brew list --cask` | `brew_list`, `brew_leaves`, `brew_cask` | Record Homebrew inventory. | Installed tools and applications, including organizational preferences. | Retain. |
| `brew services list` | `brew_services` | Record managed service state. | Services, status, usernames, and launch paths. | Retain; document identity and path exposure. |
| `brew bundle dump --file=-` | `Brewfile` | Produce a portable reference inventory. | Taps, packages, applications, and potentially private or custom source URLs. | Retain; explicitly identify private-URL risk. |
| `npm list -g --depth=0`, `pipx list --json`, `uv tool list ...`, `pyenv versions --bare` | `npm_global`, `pipx`, `uv_tools`, `pyenv_versions` | Record globally installed language tools and runtimes. | Package names, versions, environment names, private scopes or URLs, and local paths. | Retain; document. |
| `.nvmrc` | `nvmrc` | Preserve the preferred Node.js version. | Usually a version, but the file is arbitrary user-authored content. | Retain. |
| `mas list` | `mas` | Record installed Mac App Store applications. | Application choices and versions. | Retain; document preference metadata. |

Any new snapshot category requires an explicit inclusion and sensitivity review
before it is added to Ballin's backup source allowlist.
