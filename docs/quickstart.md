# Your first Ballin backup

You’ll need a [GitHub account](https://github.com/signup).

Open Terminal and paste:

```shell
bash -c 's=$(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

Follow the prompts to complete setup and create your first private backup.

Optional reading: [installation details](installation.md#quickstart-helper) · [backup sources and privacy](backup-sources.md).
