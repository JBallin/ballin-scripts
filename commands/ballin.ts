const format = {
  fileName: '\x1b[4mfile name\x1b[0m',
  key: '\x1b[4mkey\x1b[0m',
  value: '\x1b[4mvalue\x1b[0m',
  get: '\x1b[1mget\x1b[0m',
  set: '\x1b[1mset\x1b[0m',
  empty: "\x1b[1m''\x1b[0m",
  reset: '\x1b[1mreset\x1b[0m',
  open: '\x1b[1mopen\x1b[0m',
  read: '\x1b[1mread\x1b[0m',
};

const examples = {
  get: '(ex: get up.cleanup)',
  set: '(ex: set up.cleanup true)',
};

const ballinHelp = `
A Collection of Ballin Scripts!
https://github.com/JBallin/ballin-scripts

Commands:

    ballin_update         update to latest version
    ballin_config         ${format.empty}/${format.get} view entire config
                          ${format.get} ${format.key} ${examples.get}
                          ${format.set} ${format.key} ${format.value} ${examples.set}
                          ${format.reset} (to defaults)
    ballin_uninstall      remove ballin-scripts

Scripts:

    gu                    gist: ${format.empty} (update), ${format.open}, ${format.read} ${format.fileName}
    up                    update brew etc.

`;

const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

const runBallinCli = (): void => {
  writeStdout(ballinHelp);
};

module.exports = {
  runBallinCli,
};
