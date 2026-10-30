const { formatHelp } = require('../commands/help_format.ts');
const { configAction } = require('./index.ts');
const { terminalCommandReferences } = require('../commands/terminalStyle.ts');
const { ConfigError } = require('./store.ts');
const { Console } = require('node:console');
const { commandHelpOptionName } = require('../commands/top_level_commands.ts');
const { isConfigOperationName } = require('./commands.ts');
import type { ConfigError as ConfigFailure } from './store.ts';

const configConsole = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });

const configHelp = `Usage:
    ballin config [get [key]]
    ballin config set <key> <value>
    ballin config reset

Read settings with dot paths, such as \`update.cleanup\`. \`set\` changes an existing setting. \`reset\` replaces all saved settings with defaults, including backup linkage; remote backups remain unchanged.

Examples:
    ballin config get update.backup
    ballin config set update.backup false

🔗 Configuration guide:
https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#working-with-settings
`;

const isConfigHelp = (args: string[]): boolean => (
  (args.length === 1 && (args[0] === 'help' || args[0] === commandHelpOptionName))
  || (args.length === 2 && isConfigOperationName(args[0]) && args[1] === commandHelpOptionName)
);

const runConfigCli = (args: string[] = process.argv.slice(2)): void => {
  if (isConfigHelp(args)) {
    process.stdout.write(formatHelp(configHelp));
    process.exitCode = 0;
    return;
  }

  try {
    configConsole.log(configAction(args));
    process.exitCode = 0;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const failure = error as ConfigFailure;
    const message = terminalCommandReferences(failure.message, ['ballin config get', 'ballin config reset'], process.stderr);
    process.stderr.write(`ballin config: ${message}\n${failure.exitCode === 2 ? formatHelp(configHelp, process.stderr) : ''}`);
    process.exitCode = failure.exitCode;
  }
};

module.exports = {
  configHelp,
  isConfigHelp,
  runConfigCli,
};
