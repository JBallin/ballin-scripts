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

Snapshots are references for manual setup. Ballin does not automatically restore
dotfiles or reinstall packages, and it does not synchronize Macs. Keep a broader
backup for documents, applications, and other data.

Check each snapshot's own commit history before using it. A missing or excluded
local source leaves its previously saved snapshot in place, so the repository's
latest backup time does not mean every saved file is still in use.

## Review assistant configuration

Install and sign in to Codex or Claude Code separately. Separate authentication
stores, sessions, plugin installations, caches, and files merely referenced by
configuration are not included. Reinstall the required plugins and tools and review commands before
running saved hooks, MCP servers, or skill scripts.

Merge the settings you want into the new installation rather than overwriting
its fresh configuration. Review project trust, hook approvals, permissions,
machine-specific paths, and custom service definitions. Codex uses `CODEX_HOME`
when set, otherwise `~/.codex`; shared personal skills stay at `~/.agents/skills/`
independently of that setting. Claude Code uses `CLAUDE_CONFIG_DIR` when set,
otherwise `~/.claude`. Consult [source boundaries](backup-sources.md) before
assuming a setting or supporting file was saved.

Claude Code's raw user settings and `.claude.json` are excluded, so their saved
permissions, hooks, and MCP/plugin configuration are not available from these
snapshots. Hooks embedded in selected agent Markdown can still be present.

New `codex_config.toml` snapshots omit narrowly recognized app-version metadata
and the bundled browser service's cached path. Automatic regeneration of those
entries after a restore has not been verified. Review the installed app's fresh
configuration and verify browser tools after setup. Older snapshots can still
contain stale versioned paths. Other services and saved preferences remain
included; named profiles are not filtered.

Files ending in `.bundle.json` are archives, not application configuration files
to copy into place. On a connected Mac, inspect members with
`ballin backup read <bundle> --list` and
`ballin backup read <bundle> --file <path>`. Choose the files to recreate and review
their saved executable flags. These commands inspect snapshots; they do not
restore files or apply permissions.

## Choose a backup destination

When the new Mac is ready, choose where to capture its future state during
backup setup:

- **Reuse the existing repository:** choose the original hostname and reconnect using
  its owning individual account. Stop backups on the old Mac before publishing from the new
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
