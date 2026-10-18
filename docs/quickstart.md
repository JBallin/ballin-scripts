# Quickstart: Install Ballin

Install Ballin for maintenance and updates, with optional private GitHub backups.
You’ll need a [GitHub account](https://github.com/signup) only for backups.

Open Terminal and paste:

```shell
BALLIN_SHELL_PID=$$ BALLIN_SHELL_HOME="$HOME" BALLIN_SHELL_CONFIGURED="${SHELL-}" BALLIN_SHELL_ZDOTDIR_SET="${ZDOTDIR+x}" BALLIN_SHELL_ZDOTDIR="${ZDOTDIR-}" bash -c 's=$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh -o -) && export -n s && bash /dev/fd/3 3<<<"$s"'
```

Choose whether to set up backups, then follow the prompts in the same Terminal.
Missing prerequisites, startup-file changes, installation, analytics, completion
and the final backup destination have separate permissions. Open a new Terminal
after setup.

Optional reading: [installation details](installation.md#quickstart-helper) · [backup sources and privacy](backup-sources.md).
