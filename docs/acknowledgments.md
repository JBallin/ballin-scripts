# Acknowledgments

*A thank-you to the projects behind Ballin and a guide to discovering them.*

Ballin builds on the work of many maintainers and contributors. Thank you for
the tools that make it possible, and for the developer environments it helps
look after.

## Tools Ballin works with

Git and Node.js are installer prerequisites. The update integrations and backup
sources below are optional; you can use Ballin without adopting every tool.

| Project | How Ballin uses it |
| --- | --- |
| [macOS](https://www.apple.com/macos/) and [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/) | The platform Ballin runs on. Quickstart can obtain Git through Command Line Tools; optional system updates use macOS `softwareupdate`. |
| [Git](https://git-scm.com/) | Installs and updates the Ballin checkout. Git configuration and global ignore files are also supported backup sources. |
| [Node.js](https://nodejs.org/) and [npm](https://docs.npmjs.com/) | Node.js runs Ballin. npm supplies development dependencies, global-package inventories, and optional global-package updates. |
| [Bash](https://www.gnu.org/software/bash/) and [Zsh](https://www.zsh.org/) | Shells used for setup scripts and command completion. Ballin can back up supported shell startup files and inventory Homebrew Bash completions. |
| [curl](https://curl.se/) | Downloads installer scripts and prerequisite releases during Quickstart. |
| [GitHub](https://github.com/) and [GitHub CLI](https://cli.github.com/) | GitHub hosts Ballin; `gh` connects optional backups to a GitHub repository. |
| [Homebrew](https://brew.sh/) | Optional package and app updates, health checks, and inventories of installed packages, apps, and services. |
| [nvm](https://github.com/nvm-sh/nvm) | Optional Node.js LTS installation during `ballin update`. The home-directory `.nvmrc` is also a supported backup source. |
| [mas](https://github.com/mas-cli/mas) | Optional Mac App Store app updates and installed-app inventories. |
| [Visual Studio Code](https://code.visualstudio.com/) | Settings, keybindings, and extension inventories are supported backup sources for both stable and Insiders editions. |
| [Vim](https://www.vim.org/) and [GNU nano](https://www.nano-editor.org/) | Their `.vimrc` and `.nanorc` editor configuration files are supported backup sources. |
| [Codex](https://developers.openai.com/codex/) and [Claude Code](https://code.claude.com/docs/en/overview) | Supported personal instructions, configuration, and authoring files, including skills, can be backed up. |
| [pipx](https://pipx.pypa.io/), [uv](https://docs.astral.sh/uv/), and [pyenv](https://github.com/pyenv/pyenv) | Backups can record Python tool installations and installed Python versions. |

Raw configuration and some tool metadata require the sensitive-source opt-in.
See [Backup sources and sensitivity](backup-sources.md) for what is collected,
[Supported capabilities](capabilities.md) for update behavior, and
[Optional capabilities](optional-capabilities.md) for setup and settings.

## Building and running the project

Thanks also to [TypeScript](https://www.typescriptlang.org/),
[ESLint](https://eslint.org/), [Mocha](https://mochajs.org/),
[Chai](https://www.chaijs.com/), and [c8](https://github.com/bcoe/c8) for the
development checks, tests, and coverage tools. Ballin's Node.js CLI has no
runtime npm dependencies.

[GitHub Actions](https://github.com/features/actions) runs automated checks, and
[Cloudflare Workers](https://developers.cloudflare.com/workers/) and
[D1](https://developers.cloudflare.com/d1/) power the optional
[analytics backend](analytics-backend.md).
