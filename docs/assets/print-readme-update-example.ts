const { terminalHeading } = require('../../commands/terminalStyle.ts') as {
  terminalHeading: (text: string, stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv) => string;
};

const example = [
  '==> Updating Homebrew...',
  '...',
  '==> Updating Homebrew packages',
  '...',
  '==> Cleaning up Homebrew packages',
  '...',
  '==> Checking Homebrew installation',
  '...',
  '==> Updating Node.js LTS',
  '...',
  '==> Updating global npm packages',
  '...',
  '==> Updating App Store apps',
  '...',
  '==> Installing macOS updates',
  '...',
  '==> Updating Ballin',
  '...',
  '==> Checking Ballin readiness',
  '...',
  '==> Backing up development environment',
  'Last successful backup: Dec 31, 2025, 4:00:00 PM GMT-08:00',
  '✔ ballin_config',
  '✔ bash_completions',
  '✔ Brewfile',
  '...',
  '✎ zshrc',
  'View changes: https://github.com/example-user/ballin-backups/commit/0123456789abcdef0123456789abcdef01234567',
];

const output = example.map((line) => line.startsWith('==> ')
  ? terminalHeading(line.slice(4), { isTTY: true }, { TERM: 'xterm-256color' })
  : line);

process.stdout.write(`\x1b[1m$ ballin update\x1b[0m\n${output.join('\n')}\n`);
