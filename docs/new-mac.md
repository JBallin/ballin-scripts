# Using saved state on another Mac

*For users rebuilding a Mac with saved Ballin snapshots.*

## Review your saved state

Open your existing private backup repository on GitHub with an account authorized
to read it. Browse its snapshots and commit history while setting up the new Mac;
this does not require installing Ballin or reconnecting backup storage.

- Review the saved Brewfile to choose packages, then use Homebrew Bundle separately
  to install them.
- Use editor-extension inventories to identify tools to reinstall.
- Review any saved dotfiles before copying or executing them, and manually adapt
  paths and settings to the new machine. See [Backup sources and sensitivity](backup-sources.md)
  for what those files can contain.

On a Mac already connected to the backup, `ballin backup list` shows saved
snapshot names and `ballin backup read Brewfile` prints the saved Brewfile, if
present. `ballin backup open` opens the repository and its history on GitHub.

Normal CLI reads support up to 32 MiB per stored snapshot and 64 MiB per full
current snapshot set. If an older backup exceeds these limits, its saved data
and history stay intact. Use `ballin backup open`, or browse the existing private
repository directly with an authorized GitHub account, to review and download
individual raw files deliberately. Ballin does not automatically decode or
restore downloaded files. An oversized set can prevent reconnecting; choosing
a new destination preserves the old repository as a reference.

Snapshots are references for manual setup. Ballin does not automatically restore
dotfiles or reinstall packages, and it does not synchronize Macs. Keep a broader
backup for documents, applications, and other data.

## Choose a backup destination

When the new Mac is ready, choose where to capture its future state during
backup setup:

- **Reuse the existing repository:** choose reconnect using its owning personal
  GitHub.com account. Stop backups on the old Mac before publishing from the new
  one; only one Mac should write to a destination. Follow the
  [conflict guidance](capabilities.md#backup-consistency-and-conflicts) before
  backing up from the replacement Mac.
- **Create a new repository:** choose a different repository name for the new
  Mac. Keep the old repository and its history as a reference. To keep that
  reference unchanged, stop the old Mac from publishing to it.

Reconnect changes local setup: it saves the destination and sensitive-source
choice and can recover [supported Ballin preferences](optional-capabilities.md#recovering-ballin-preferences)
while preserving existing local choices. Browsing the repository on GitHub
requires none of those changes. Creating a new destination leaves the old
repository and its history in place.

See [backup setup and reconnect](installation.md#optional-backup-setup-and-reconnect)
for setup, authentication, and source-selection details.
