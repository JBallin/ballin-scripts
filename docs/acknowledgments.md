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
| [Node.js](https://nodejs.org/) and [npm](https://docs.npmjs.com/) | Node.js runs Ballin; npm supports development. |
| [Bash](https://www.gnu.org/software/bash/) and [Zsh](https://www.zsh.org/) | Run Ballin's shell scripts and support command completion. |
| [curl](https://curl.se/) | Downloads resources used by Ballin. |
| [GitHub](https://github.com/) and [GitHub CLI](https://cli.github.com/) | GitHub hosts Ballin; the CLI connects optional backups. |
| [Homebrew](https://brew.sh/) | Supports optional macOS package management. |
| [nvm](https://github.com/nvm-sh/nvm) | Manages Node.js versions. |
| [mas](https://github.com/mas-cli/mas) | Updates Mac App Store apps. |
| [Visual Studio Code](https://code.visualstudio.com/) | Supports editor-configuration backups. |
| [Vim](https://www.vim.org/) and [GNU nano](https://www.nano-editor.org/) | Support backups of editor configuration. |
| [Codex](https://developers.openai.com/codex/) and [Claude Code](https://code.claude.com/docs/en/overview) | Support backups of personal instructions and configuration. |
| [pipx](https://pipx.pypa.io/), [uv](https://docs.astral.sh/uv/), and [pyenv](https://github.com/pyenv/pyenv) | Support backups of Python tooling. |

## Building and running the project

[TypeScript](https://www.typescriptlang.org/), [ESLint](https://eslint.org/),
[Mocha](https://mochajs.org/), [Chai](https://www.chaijs.com/), and
[c8](https://github.com/bcoe/c8) support development checks, tests, and coverage.
Ballin's Node.js CLI has no runtime npm dependencies.

[Tart](https://github.com/openai/tart) provides macOS virtual machines used to
test installation.

[GitHub Actions](https://github.com/features/actions) runs automated checks, and
[Cloudflare Workers](https://developers.cloudflare.com/workers/) and
[D1](https://developers.cloudflare.com/d1/) power the optional
[analytics backend](analytics-backend.md).
