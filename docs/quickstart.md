# Quickstart: Install Ballin

You’ll need a [GitHub account](https://github.com/signup) only if you choose to set up backups.
Quickstart’s guided sign-in uses GitHub.com. For a GitHub Enterprise Server
backup, choose maintenance-only installation here, then follow
[custom-host backup setup](installation.md#github-account-and-host-support).

Open Terminal and paste:

```shell
bash -c 's=$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

Optional reading: [installation details](installation.md#quickstart-helper) · [backup sources and privacy](backup-sources.md).
