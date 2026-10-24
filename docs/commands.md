# Command reference

Use `ballin help` to see available commands, or `ballin help <command...>` for
syntax and options, such as `ballin help backup read`.

*Square brackets mark optional arguments; angle brackets mark required values.*

| Command | Purpose |
| --- | --- |
| `ballin help [command...]` | Shows available commands or help for a command or subcommand. |
| [`ballin update`](capabilities.md#ballin-update) | Runs configured update tasks. |
| [`ballin backup`](capabilities.md#ballin-backup) | Updates snapshots in the configured backup. |
| [`ballin backup setup [repository-name]`](installation.md#optional-backup-setup-and-reconnect) | Creates, reconnects to, or revalidates a private backup repository. |
| [`ballin backup open`](installation.md#inspect-saved-backups) | Opens the backup and its history in your browser. |
| [`ballin backup list`](installation.md#inspect-saved-backups) | Lists supported saved snapshots. |
| [`ballin backup read <snapshot>`](installation.md#inspect-saved-backups) | Prints a saved snapshot's original contents. |
| [`ballin backup read <snapshot> --list`](installation.md#inspect-saved-backups) | Lists file paths in a saved bundle snapshot. |
| [`ballin backup read <snapshot> --file <path>`](installation.md#inspect-saved-backups) | Prints one file's original contents from a bundle snapshot. |
| [`ballin backup disconnect`](installation.md#disconnect) | Disconnects this Mac from its backup and disables automatic backups. |
| [`ballin doctor`](capabilities.md#ballin-doctor) | Checks the managed environment. |
| [`ballin doctor --verbose`](optional-capabilities.md#readiness-checks) | Shows full readiness details. |
| [`ballin setup`](optional-capabilities.md#guided-preference-review) | Reviews local onboarding preferences. |
| [`ballin config`](optional-capabilities.md#working-with-settings) | Prints all local Ballin settings. |
| [`ballin config get [key]`](optional-capabilities.md#working-with-settings) | Prints one setting or, without a key, all settings. |
| [`ballin config set <key> <value>`](optional-capabilities.md#working-with-settings) | Changes an existing setting. |
| [`ballin config reset`](optional-capabilities.md#working-with-settings) | Replaces saved settings with defaults. |
| `ballin self-update` | Updates Ballin itself. |
| [`ballin uninstall`](installation.md#uninstall) | Removes Ballin. |
