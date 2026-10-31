// A guard against accidental escapes by trusted QA code, not an OS sandbox.
const fs = require('fs');
const path = require('path');
const root = process.env.BALLIN_QA_ROOT;
const fail = (): never => { throw new Error('Onboarding sandbox safeguard refused the operation'); };
const quickstart = root && JSON.parse(fs.readFileSync(path.join(root, '.ballin-onboarding-sandbox.json'), 'utf8')).quickstart === true;
const nvmBin = root && path.join(root, 'home/.config/nvm/versions/node/v26.13.0/bin');
const allowedPaths = root && (quickstart
  ? [[path.join(root, 'tools'), path.join(root, 'home/.local/bin')].join(path.delimiter), path.join(root, 'tools')]
  : [[path.join(root, 'tools'), path.join(root, 'home/.local/bin')].join(path.delimiter)]);
if (Array.isArray(allowedPaths) && quickstart && nvmBin && fs.existsSync(path.join(nvmBin, 'node'))) {
  if (!fs.lstatSync(path.join(nvmBin, 'node')).isSymbolicLink() || fs.realpathSync(path.join(nvmBin, 'node')) !== fs.realpathSync(process.execPath)) fail();
  allowedPaths.push(...allowedPaths.map(value => `${nvmBin}:${value}`));
}
if (process.env.BALLIN_NO_ANALYTICS !== '1' || !root || fs.realpathSync(root) !== root || process.env.HOME !== path.join(root, 'home')
  || !allowedPaths?.includes(process.env.PATH ?? '')) fail();

// Piped walkthroughs need a terminal-detection seam; real PTYs use real detection.
// Do not construct process.stdin: its stream changes synchronous fd 0 reads.
const tty = require('tty');
if (quickstart && !tty.isatty(0)) tty.isatty = (fd: number) => fd === 0;

const deny = (): never => fail();
require('net').Socket.prototype.connect = deny;
require('tls').connect = deny;
for (const name of ['http', 'https']) {
  const transport = require(name);
  transport.request = deny;
  transport.get = deny;
}
require('dgram').createSocket = deny;
for (const resolver of [require('dns'), require('dns').promises]) {
  for (const name of Object.keys(resolver)) {
    if (/^(lookup|resolve|reverse)/u.test(name)) resolver[name] = deny;
  }
}
globalThis.fetch = deny;

const childProcess = require('child_process');
const installedBallin = path.join(root, 'home/.ballin-scripts/bin/ballin');
for (const name of ['exec', 'execSync']) childProcess[name] = deny;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = (command: string, ...args: unknown[]) => {
    if (name === 'fork') fail();
    const candidate = command.includes(path.sep) ? path.resolve(command) : path.join(root, 'tools', command);
    const probeArgs = args[0] as string[];
    const probeEnv = (args[1] as { env?: NodeJS.ProcessEnv })?.env;
    if (quickstart && command === '/bin/bash' && probeArgs?.[0] === '--noprofile' && probeArgs[1] === '--norc'
      && probeArgs[4] === 'ballin-nvm-probe' && probeArgs.length === 6
      && probeArgs[3] === '. "$1" --no-use >/dev/null && declare -F nvm >/dev/null || exit 1; printf "loadable\\n"; nvm version default'
      && probeArgs[5] === path.join(root, 'home/.config/nvm/nvm.sh')
      && fs.readFileSync(probeArgs[5], 'utf8') === fs.readFileSync(path.join(root, 'nvm-fixture.sh'), 'utf8')
      && probeEnv?.HOME?.startsWith(path.join(root, 'tmp/ballin-nvm-probe-')) && probeEnv.NVM_DIR === path.join(probeEnv.HOME, 'nvm')
      && probeEnv.PATH === process.env.PATH && probeEnv.BASH_ENV === '' && probeEnv.ENV === '') return original(command, ...args);
    if (candidate !== process.execPath && !candidate.startsWith(path.join(root, 'tools') + path.sep)
      && candidate !== path.join(root, 'home/.local/bin/ballin') && candidate !== installedBallin) fail();
    if (candidate === installedBallin) {
      if (fs.realpathSync(candidate) !== installedBallin || !fs.lstatSync(candidate).isFile()) fail();
      fs.accessSync(candidate, fs.constants.X_OK);
    }
    const options = args.find((value) => value && typeof value === 'object' && !Array.isArray(value)) as { env?: NodeJS.ProcessEnv; shell?: unknown; cwd?: string } | undefined;
    const env = options?.env ?? process.env;
    if (env.BALLIN_NO_ANALYTICS !== '1' || options?.shell || env.HOME !== process.env.HOME || env.PATH !== process.env.PATH
      || env.NODE_OPTIONS !== process.env.NODE_OPTIONS || env.BALLIN_QA_ROOT !== root
      || (options?.cwd && !path.resolve(options.cwd).startsWith(root + path.sep))) fail();
    return original(command, ...args);
  };
}
