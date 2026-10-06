# Your first Ballin backup

*A quickstart for Mac users who want to save their tools and configuration.*

On macOS 13.5 or newer, open Terminal. Paste this, answer any prompts:

```shell
bash <(curl -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh)
```

The [helper](../quickstart.sh) reuses working Git, Node.js 24.12 or newer, and
GitHub CLI. It offers to install missing prerequisites from official sources,
then runs the existing Ballin installer. Node's macOS package may replace
Node.js/npm in `/usr/local` and asks for your Mac password. A confirmed startup
file change makes the selected tools available in new Terminal windows.
See [installation effects](installation.md#quickstart-helper) for details.

In Ballin setup, choose **yes** for private backups, **create** for a new backup,
and press Enter to accept `ballin-backups` as its name. Check that the displayed
GitHub account and destination are yours before confirming. Analytics,
completion, and automatic backups are optional; choose what suits you.

To include supported local Codex or Claude skills, choose **yes** for sensitive
sources. This also includes other supported configuration and future sensitive
sources; it is not a skills-only choice. Ballin does not scan or redact secrets.
GitHub and anyone authorized to access the repository can read its contents.
Review the [source list](backup-sources.md) before opting in.

After successful setup, the helper runs the first backup and opens its private
GitHub page only if the backup succeeds. Inspect the saved snapshots there;
skill folders are stored in `.bundle.json` files.

Later, open a new Terminal window and run `ballin backup` whenever you want to
save changes. Optionally, try
`ballin update` for maintenance of supported tools.
