# Your first Ballin backup

On macOS 13.5 or newer, open Terminal and paste:

```shell
bash -c 's=$(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

The helper reuses Git, compatible Node.js, and GitHub CLI, asking before
installing missing tools or changing your Terminal startup file. Node's
installer may replace Node.js/npm in `/usr/local` and ask for your Mac password.

During setup:

- Select the startup file your Terminal reads (`home` for standard zsh); skip if unsure.
- Choose **yes** for private backups, **create**, and press Enter for
  `ballin-backups`. Check your GitHub account and destination before confirming.
- Analytics, completion, and automatic backups are optional.

Sensitive backups include local Claude/Codex skills and all other supported
sensitive sources, which may contain secrets. Ballin does not redact secrets.
GitHub and authorized accounts can read the contents.
[Review the source list](backup-sources.md) before choosing **yes**;
choose **no** if unsure.

At the first-backup prompt, press Enter to back up and open its private GitHub
destination; enter `n` to skip both. Inspect the saved files on GitHub.

For setup help and recovery, see [installation details](installation.md#quickstart-helper).
