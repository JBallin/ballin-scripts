const { configAction } = require('./index.ts');
const { ConfigError } = require('./store.ts');
import type { ConfigError as ConfigFailure } from './store.ts';

const configHelp = `Usage:
    ballin config [get [key]]
    ballin config set <key> <value>
    ballin config reset
    ballin config help
    ballin config --help

Read settings with dot paths, such as update.cleanup.
set updates an existing leaf; reset restores defaults.
`;

const runConfigCli = (args: string[] = process.argv.slice(2)): void => {
  if (args.length === 1 && (args[0] === 'help' || args[0] === '--help')) {
    process.stdout.write(configHelp);
    process.exitCode = 0;
    return;
  }

  try {
    console.log(configAction(args)); // eslint-disable-line no-console
    process.exitCode = 0;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const failure = error as ConfigFailure;
    process.stderr.write(`ballin config: ${failure.message}\n${failure.exitCode === 2 ? configHelp : ''}`);
    process.exitCode = failure.exitCode;
  }
};

module.exports = {
  configHelp,
  runConfigCli,
};
