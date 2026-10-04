# Choosing Ballin

**Audience:** Developers deciding how to maintain an existing Mac setup.

Ballin saves selected development-environment snapshots in a private GitHub
repository and runs configurable maintenance tasks. Choose it when you want a
record of the Mac you already use and a shared command for routine updates.
Saved snapshots are rebuild references: Ballin does not restore your dotfiles
or reinstall your packages automatically.

## When it fits

Ballin is worth considering if you work mainly on one Mac, use Homebrew, and
have accumulated settings and tools without maintaining a complete setup
repository. Its fixed source selection covers supported shell, Git, editor,
and tool state; it does not discover everything installed on your Mac.
Raw shell, Git, and editor configuration requires a separate sensitive-source
opt-in. Review [backup sources and sensitivity](backup-sources.md) before
deciding what to include.

You can also use maintenance alone. Backup setup is optional, so running
configured updates does not require uploading your settings to GitHub.
See [optional capabilities](optional-capabilities.md) for the update controls.
Installation requires Git and Node.js; Homebrew stages require Homebrew, and
optional backups require GitHub CLI and a personal GitHub account. Review the
[installation effects](installation.md), enabled stages, and captured sources
when setting up Ballin and as your environment changes.

## When to choose something else

Choose a dotfile manager and a setup script if your priority is applying a
maintained configuration to new machines or managing differences between Macs.
Choose an organizational management system for fleet policy and enforcement.
Keep a broader backup and recovery system for your documents, applications,
and other personal data.

Ballin supports one active Mac writing to each backup destination. Its conflict
checks protect saved content from some conflicting writes; they do not provide
multi-Mac synchronization. `ballin doctor` checks readiness, not whether every
source is captured or a saved snapshot is current.

Private GitHub storage is not client-side encryption. GitHub and authorized
accounts can read the saved contents. Ballin does not scan or redact secrets;
even inventories can contain private names, paths, and URLs.

## Other useful workflows

- **[Homebrew Bundle](https://docs.brew.sh/Brew-Bundle-and-Brewfile):** Save
  supported installed packages with `brew bundle dump`, review a Brewfile, and
  use it to install or upgrade packages on another machine. Bundle can start
  from an existing Mac too. Ballin uses Bundle to capture its Brewfile and adds
  selected configuration snapshots and maintenance stages. A Brewfile is not
  an exact version lock.
- **[chezmoi](https://www.chezmoi.io/user-guide/daily-operations/):** Select
  existing dotfiles, maintain their source state, inspect the proposed diff,
  and apply it. Its templates and secret integrations suit configurations
  that need machine-specific behavior. Ballin captures selected local state
  without providing that apply workflow.
- **[yadm](https://yadm.io/docs/overview):** Track chosen dotfiles with Git,
  inspect changes, and clone the repository for another machine. Alternate
  files and optional encryption support more deliberate configuration
  management. You choose the tracked files and maintain the repository.
- **[Mackup](https://github.com/lra/mackup):** Copy supported application
  settings to a configured folder and restore them on another machine.
  Mackup recommends copy mode on current macOS; its documentation warns that
  link mode breaks preferences on macOS 14 and later. Ballin saves selected
  snapshots without offering application-settings restoration.
- **[Time Machine](https://support.apple.com/en-us/104984):** Back up your
  files and recover them later, including when moving to another Mac. Keep
  it alongside Ballin when you need broader recovery coverage.
- **[Editor settings sync](https://code.visualstudio.com/docs/configure/settings-sync):**
  Use your editor's own workflow for supported settings and extensions across
  devices. For example, VS Code offers sync and conflict handling. Ballin's
  editor snapshots are saved references, not an editor sync service.

A realistic alternative is **Homebrew Bundle + chezmoi or yadm + editor sync
or Mackup + a small maintenance/setup script**. This gives you an explicit
package and configuration workflow for new machines. You still choose the
sources, storage, machine differences, and script behavior. Ballin is a useful
choice when its selected sources and update controls match what you need;
there is no need to add it to a stack that already serves you well.

## Is a small script enough?

A shell function or an AI-generated script can be enough for a few familiar
update commands. Choose it when you can review its effects and are comfortable
maintaining its prerequisites and failure handling.

Ballin supplies configurable update stages, readiness diagnostics, and an
optional snapshot workflow with conflict checks and GitHub history. Those
behaviors go beyond a list of update commands, but a custom script can implement
them too. Adopting Ballin still means reviewing its configuration, updates, and
backup contents; it does not remove ownership of your environment.

## Keep useful tools together

Keep Time Machine for broader recovery and editor sync for supported editor
settings. If two tools run the same maintenance task, choose which one owns it
and disable the duplicate stage.

You can review a saved Brewfile and use Homebrew Bundle separately when rebuilding.
Other inventories may require interpretation or manual steps. Use
`ballin backup read <file>` to read saved content. Open the repository with
`ballin backup open` to inspect its GitHub history. Review files before copying
or executing them.

Snapshots can also help you select files for a future chezmoi or yadm repository.
The saved text remains useful outside Ballin, but moving to a dotfile manager
requires deciding which configuration to manage and how to apply it.
