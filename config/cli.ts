const { configAction } = require('./index.ts');

type ConfigCliArgs = string[];

const runConfigCli = (args: ConfigCliArgs = process.argv.slice(2)) => {
  const [request, keys, value, ...other] = args;
  console.log(configAction(request, keys, value, other)); // eslint-disable-line no-console
};

module.exports = {
  runConfigCli,
};
