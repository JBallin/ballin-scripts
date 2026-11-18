# Acknowledgments

*A thank-you to the projects behind Ballin and a guide to discovering them.*

Ballin builds on the work of many maintainers and contributors. Thank you for
the tools that make it possible, and for the developer environments it helps
look after.

## Tools Ballin works with

| Project | How Ballin uses it |
| --- | --- |
| [macOS](https://www.apple.com/macos/) and [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/) | Ballin's macOS platform and command-line foundation. |
| [Git](https://git-scm.com/) | Tracks Ballin's source and supports repository backups. |
| [Node.js](https://nodejs.org/) and [npm](https://docs.npmjs.com/) | Node.js runs Ballin; npm supports development, global-package updates, and inventories. |
| [Bash](https://www.gnu.org/software/bash/) and [Zsh](https://www.zsh.org/) | Run Ballin's shell scripts and support command completion. |
| [curl](https://curl.se/) | Downloads resources used by Ballin. |
| [GitHub](https://github.com/) and [GitHub CLI](https://cli.github.com/) | GitHub hosts Ballin; the CLI connects optional backups. |
| [Homebrew](https://brew.sh/) | Supports optional package updates, health checks, and inventories. |
| [nvm](https://github.com/nvm-sh/nvm) | Installs Node.js LTS during optional updates. |
| [mas](https://github.com/mas-cli/mas) | Updates Mac App Store apps. |
| [Visual Studio Code](https://code.visualstudio.com/) | Ballin can back up its settings, keybindings, and extension inventories. |
| [Vim](https://www.vim.org/) and [GNU nano](https://www.nano-editor.org/) | Ballin can back up their editor configuration. |
| [Codex](https://developers.openai.com/codex/) and [Claude Code](https://code.claude.com/docs/en/overview) | Ballin can back up supported personal instructions, configuration, and skills. |
| [pipx](https://pipx.pypa.io/), [uv](https://docs.astral.sh/uv/), and [pyenv](https://github.com/pyenv/pyenv) | Ballin can back up inventories of installed Python tools and versions. |

## Building and running the project

[TypeScript](https://www.typescriptlang.org/), [ESLint](https://eslint.org/),
[Mocha](https://mochajs.org/), [Chai](https://www.chaijs.com/), and
[c8](https://github.com/bcoe/c8) support development checks, tests, and coverage.
Ballin's Node.js CLI has no runtime npm dependencies.

[Codex](https://developers.openai.com/codex/) and [Claude Code](https://code.claude.com/docs/en/overview)
assist with Ballin's development and code review. The [Claude Review Runtime](https://github.com/JBallin/claude-review-runtime)
coordinates Claude PR reviews and reports their status.

[Tart](https://github.com/openai/tart) provides macOS virtual machines used to
[test installation](installation-testing.md).

[GitHub Actions](https://github.com/features/actions) runs automated checks, and
[Cloudflare Workers](https://developers.cloudflare.com/workers/) and
[D1](https://developers.cloudflare.com/d1/) power the optional
[analytics backend](analytics-backend.md).

[Python](https://www.python.org/) runs the site and gallery tooling, and
[markdown-it](https://github.com/markdown-it/markdown-it) renders the site's
canonical Markdown. The website targets [Netlify](https://www.netlify.com/)
for production hosting and optional review previews.
