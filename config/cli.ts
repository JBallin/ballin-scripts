const { configAction } = require('./index.ts');

type ConfigCliArgs = string[];
type WriteLine = (output: unknown) => void;

const writeStdoutLine: WriteLine = (output) => {
  console.log(output); // eslint-disable-line no-console
};

const runConfigCli = (args: ConfigCliArgs = process.argv.slice(2), writeLine: WriteLine = writeStdoutLine) => {
  const [request, keys, value, ...other] = args;
  writeLine(configAction(request, keys, value, other));
};

module.exports = {
  runConfigCli,
};
