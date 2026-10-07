# Your first Ballin backup

On macOS 13.5 or newer, open Terminal and paste:

```shell
bash -c 'set -e; quickstart_file=$(mktemp); cleanup() { rm -f -- "$quickstart_file"; }; trap cleanup EXIT; curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o "$quickstart_file"; bash "$quickstart_file"'
```

The helper reuses working Git, Node.js 24.12 or newer, and GitHub CLI. It asks
before installing missing tools or changing your Terminal startup file. Node's
installer may replace Node.js/npm in `/usr/local` and ask for your Mac password.
See [installation details](installation.md#quickstart-helper).

During setup:

- Sign into GitHub if asked.
- Choose **yes** for private backups, **create**, and press Enter for
  `ballin-backups`. Check your GitHub account and destination before confirming.
- Analytics, completion, and automatic backups are optional.

Sensitive backups include local Claude/Codex skills and all other supported
sensitive sources, which may contain secrets. Ballin does not redact secrets.
GitHub and authorized accounts can read the contents.
[Review the source list](backup-sources.md) before choosing **yes**;
choose **no** if unsure.

After setup, the helper captures your first backup and opens its private GitHub
page only if the backup succeeds. Inspect the saved files there.
