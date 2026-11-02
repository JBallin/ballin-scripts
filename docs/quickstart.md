# Quickstart: Install Ballin

You’ll need a [GitHub account](https://github.com/signup) only if you choose to set up backups.

Open Terminal and paste:

```shell
ballin_script=$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh) && /bin/bash -c "$ballin_script"
```

Quickstart offers NVM and latest LTS Node when needed. If your existing Node
works with Ballin, keeping it is the default. Switching requires consent and
retains older installations; global npm tools may need reinstalling. Shell
startup changes have separate permission.

Quickstart asks about GitHub backup before installation and reuses your choice
after the core installation. It then offers update and analytics preferences. You can revisit preferences with `ballin setup` and backup destinations
or sensitive sources with `ballin backup setup`.

Optional reading: [installation details](installation.md#quickstart-helper) · [backup sources and privacy](backup-sources.md).
