# Quickstart: Install Ballin

Install Ballin for maintenance and updates, with optional private GitHub backups.
You’ll need a [GitHub account](https://github.com/signup) only for backups.

## Run Quickstart

Open Terminal and paste this command (zsh or Bash):

```shell
bash -c 's=$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

Choose whether to set up backups, then follow the prompts in the same Terminal.
Installing missing tools, changing Terminal settings, installing Ballin, sharing
analytics, enabling completion and choosing a backup destination have separate
permissions. Open a new Terminal
after setup.

Optional reading: [installation details](installation.md#quickstart-helper) · [backup sources and privacy](backup-sources.md).
