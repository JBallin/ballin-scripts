// A guard against accidental escapes by trusted QA code, not an OS sandbox.
const fs = require('fs');
const path = require('path');
const root = process.env.BALLIN_QA_ROOT;
const fail = (): never => { throw new Error('Onboarding sandbox safeguard refused the operation'); };
const quickstart = root && JSON.parse(fs.readFileSync(path.join(root, '.ballin-onboarding-sandbox.json'), 'utf8')).quickstart === true;
const allowedPaths = root && (quickstart
  ? [path.join(root, 'tools'), [path.join(root, 'home/.local/share/ballin-quickstart/bin'), path.join(root, 'tools'), path.join(root, 'home/.local/bin')].join(path.delimiter)]
  : [[path.join(root, 'tools'), path.join(root, 'home/.local/bin')].join(path.delimiter)]);
if (process.env.BALLIN_NO_ANALYTICS !== '1' || !root || fs.realpathSync(root) !== root || process.env.HOME !== path.join(root, 'home')
  || !allowedPaths?.includes(process.env.PATH ?? '')) fail();

if (quickstart && process.env.PATH !== path.join(root, 'tools')) {
  const bin = path.join(root, 'home/.local/share/ballin-quickstart/bin');
  if (fs.realpathSync(bin) !== bin || fs.readdirSync(bin).sort().join(',') !== 'gh,git') fail();
  for (const name of ['git', 'gh']) {
    if (!fs.lstatSync(path.join(bin, name)).isSymbolicLink()
      || fs.readlinkSync(path.join(bin, name)) !== path.join(root, 'tools', name)) fail();
  }
}
// The production completion appender already supports this isolated TTY seam.
if (quickstart) process.stdin.isTTY = true;

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
