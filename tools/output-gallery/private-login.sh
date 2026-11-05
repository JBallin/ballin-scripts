#!/bin/bash
# Run only in a private guest Terminal after stopping all capture/recording.
set +x
set -eu

fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -eq 0 ] || fail 'Usage: bash tools/output-gallery/private-login.sh'
[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || fail 'Use a private interactive Terminal, without redirects or recording.'
[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || fail 'Remove token environment overrides before manual login.'
command -v gh >/dev/null 2>&1 || fail 'Install the official GitHub CLI first.'
git_path=$(command -v git) || fail 'Install working Git first.'
# Probing the Apple placeholder can start an installer. Check its selected
# developer tools before invoking it; never trigger installation from this helper.
if [ "$(uname -s)" = Darwin ] && [ "$git_path" = /usr/bin/git ]; then
  developer_dir=$(/usr/bin/xcode-select -p 2>/dev/null) || fail 'Install and select Apple developer tools before login.'
  [ -x "$developer_dir/usr/bin/git" ] || fail 'Selected Apple developer tools do not contain Git.'
fi
git --version >/dev/null 2>&1 || fail 'Git is not working; prepare it separately before login.'
gh --version >/dev/null 2>&1 || fail 'GitHub CLI is not working.'

printf '%s\n' 'Private GitHub login is starting for github.com.' \
  'Follow the instructions here manually. Keep this Terminal out of recordings.' \
  'Login may retain credentials in this guest. Review GitHub permissions privately.'
# No optional Git integration prompt, clipboard copy or automatic browser launch.
# Git helper inspection still runs. All authentication output stays on the TTY.
if GH_PROMPT_DISABLED=1 GH_BROWSER=/usr/bin/true BROWSER=/usr/bin/true GH_DEBUG='' \
  gh auth login --hostname github.com --git-protocol https --web \
    --clipboard=false --expiring=false </dev/null; then
  printf '%s\n' 'Login command completed. Verify the intended account privately before preserving this guest.'
else
  fail 'Login command did not complete successfully. No authentication state has been verified.'
fi
