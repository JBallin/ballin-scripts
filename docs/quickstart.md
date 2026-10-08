# Your first Ballin backup

You’ll need macOS 13.5 or newer and a [GitHub account](https://github.com/signup).
Before starting, review [backup sources and privacy](backup-sources.md).

Open Terminal and paste:

```shell
bash -c 's=$(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

The helper reuses Git, compatible Node.js, and GitHub CLI, asking before
installing missing tools or changing your Terminal startup file. Node's
installer may replace Node.js/npm in `/usr/local` and ask for your Mac password.

Follow the prompts to create your first private backup. When its GitHub page
opens, inspect the saved files.

For setup help and recovery, see [installation details](installation.md#quickstart-helper).
