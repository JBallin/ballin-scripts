# Your first Ballin backup

You’ll need a [GitHub account](https://github.com/signup).

Open Terminal and paste:

```shell
bash -c 's=$(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

The helper reuses Git, compatible Node.js, and GitHub CLI, asking before
installing missing tools or changing your Terminal startup file. Node's
installer may replace Node.js/npm in `/usr/local` and ask for your Mac password.

After following the prompts to create your first private backup, GitHub opens so you can browse your saved files.

For setup help and recovery, see [installation details](installation.md#quickstart-helper).

Recommended reading (optional): [backup sources and privacy](backup-sources.md).
