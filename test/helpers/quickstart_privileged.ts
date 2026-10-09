// Execute the actual inline body without privileges, replacing every fixed
// system command and the protected staging parent. This cannot prove root ownership.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = process.env.FAKE_ROOT;
if (!root) throw new Error('The privileged fixture requires an isolated root');
const log = (text: string): void => fs.appendFileSync(path.join(root, 'commands.log'), text + '\n');
const digest = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
const source = (): string => fs.readFileSync(path.join(root, 'package-source'), 'utf8');
const staged = (): string => path.join(fs.readFileSync(path.join(root, 'staged-directory'), 'utf8'), 'node.pkg');
const swap = (): void => {
  // Replace the source entry, including its inode, at the selected boundary.
  fs.unlinkSync(source());
  fs.writeFileSync(source(), 'replaced package\n');
};
const replaceManifest = (): void => fs.writeFileSync(path.join(path.dirname(source()), 'node-checksums.txt'),
  `${digest(Buffer.from('replaced package\n'))}  node-v24.21.0.pkg\n`);
const runCommand = (command: string, args: string[]): number => {
  log(`privileged-${command}:${args.join(' ')}`);
  if (command === 'mktemp') {
    assert.deepEqual(args, ['-d', path.join(root, 'privileged-parent/ballin-node.XXXXXX')]);
    if (process.env.FAKE_STAGE_FAIL === '1') return 71;
    const directory = fs.mkdtempSync(path.join(root, 'privileged-parent/ballin-node.'));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(root, 'staged-directory'), directory);
    process.stdout.write(directory + '\n');
  } else if (command === 'cat') {
    assert.deepEqual(args, [source()]);
    if (process.env.FAKE_COPY_FAIL === '1') return 72;
    const result = spawnSync('/bin/cat', args, { stdio: 'inherit' });
    assert.equal(result.status, 0);
    if (['after-stage', 'manifest-after-stage'].includes(process.env.FAKE_SWAP_NODE ?? '')) swap();
    if (process.env.FAKE_SWAP_NODE === 'manifest-after-stage') replaceManifest();
    if (process.env.FAKE_STAGE_CANCEL === '1') process.kill(process.ppid, 'SIGTERM');
  } else if (command === 'shasum') {
    assert.deepEqual(args, ['-a', '256', staged()]);
    if (process.env.FAKE_STAGED_HASH_FAIL === '1') return 73;
    return spawnSync('/usr/bin/shasum', args, { stdio: 'inherit' }).status ?? 97;
  } else if (command === 'pkgutil') {
    assert.deepEqual(args, ['--check-signature', staged()]);
    if (process.env.FAKE_STAGED_SIGNATURE_FAIL === '1') return 74;
    if (process.env.FAKE_SWAP_NODE === 'after-signature') swap();
    process.stdout.write(process.env.FAKE_STAGED_BAD_PUBLISHER === '1'
      ? 'Unexpected publisher\n' : 'Developer ID Installer: Node.js Foundation (HX7739G8FX)\n');
  } else if (command === 'grep') {
    assert.deepEqual(args, ['-Fq', 'Developer ID Installer: Node.js Foundation (HX7739G8FX)', path.join(path.dirname(staged()), 'signature.txt')]);
    if (process.env.FAKE_STAGED_GREP_FAIL === '1') return 76;
    return spawnSync('/usr/bin/grep', args, { stdio: 'inherit' }).status ?? 97;
  } else if (command === 'installer') {
    assert.deepEqual(args, ['-pkg', staged(), '-target', '/']);
    if (process.env.FAKE_STAGED_INSTALL_FAIL === '1') return 64;
    const stat = fs.statSync(staged());
    assert.notEqual(stat.ino, fs.statSync(source()).ino);
    fs.writeFileSync(path.join(root, 'stage-metadata.json'), JSON.stringify({
      mode: stat.mode & 0o777, nlink: stat.nlink, parentMode: fs.statSync(path.dirname(staged())).mode & 0o777,
    }));
    fs.copyFileSync(staged(), path.join(root, 'installed.pkg'));
    fs.copyFileSync(path.join(root, 'fake-tool'), path.join(process.env.FAKE_SYSTEM_NODE, 'node'));
  } else if (command === 'rm') {
    assert.deepEqual(args, ['-rf', '--', path.dirname(staged())]);
    if (process.env.FAKE_STAGE_CLEANUP_FAIL === '1') return 75;
    fs.rmSync(args[2], { recursive: true });
  } else throw new Error('Unexpected privileged fixture command');
  return 0;
};

if (process.argv[2] === '--command') {
  process.exitCode = runCommand(process.argv[3], process.argv.slice(4));
} else {
  const args = process.argv.slice(2);
  assert.equal(args.length, 9);
  assert.deepEqual(args.slice(0, 5), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '/bin/bash', '-c']);
  assert.equal(args[6], 'ballin-node-install');
  assert.match(args[7], new RegExp('^' + root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '/tmp/ballin-quickstart\\.[^/]+/node-v24[.][0-9]+[.][0-9]+[.]pkg$'));
  assert.match(args[8], /^[0-9a-f]{64}$/u);
  fs.writeFileSync(path.join(root, 'package-source'), args[7]);
  fs.writeFileSync(path.join(root, 'captured-digest'), args[8]);
  if (process.env.FAKE_SUDO_FAIL === '1') process.exit(1);
  if (process.env.FAKE_CANCEL_SUDO === '1') process.exit(130);
  if (['before-stage', 'manifest-before-stage'].includes(process.env.FAKE_SWAP_NODE ?? '')) swap();
  if (['manifest-before-stage', 'manifest-only'].includes(process.env.FAKE_SWAP_NODE ?? '')) replaceManifest();
  fs.mkdirSync(path.join(root, 'privileged-parent'));
  const commands = path.join(root, 'privileged-commands');
  fs.mkdirSync(commands);
  let body = args[5];
  const quote = (text: string): string => "'" + text.replace(/'/gu, "'\\''") + "'";
  for (const [name, executable] of Object.entries({ mktemp: '/usr/bin/mktemp', cat: '/bin/cat', shasum: '/usr/bin/shasum',
    pkgutil: '/usr/sbin/pkgutil', grep: '/usr/bin/grep', installer: '/usr/sbin/installer', rm: '/bin/rm' })) {
    assert.equal(body.split(executable).length - 1, 1, `Expected one fixed ${name} command`);
    const fixture = path.join(commands, name);
    fs.writeFileSync(fixture, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} --command ${name} "$@"\n`, { mode: 0o755 });
    body = body.replace(executable, quote(fixture));
  }
  assert.equal(body.split('/private/var/root/ballin-node.XXXXXX').length - 1, 1);
  body = body.replace('/private/var/root/ballin-node.XXXXXX', quote(path.join(root, 'privileged-parent/ballin-node.XXXXXX')));
  assert.doesNotMatch(body, /\/(?:usr|bin|private)\//u, 'No production command or protected parent may survive substitution');
  // env -i is asserted above; pass only explicit fixture controls to the local body.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FAKE_')));
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  process.exitCode = spawnSync('/bin/bash', ['-c', body, ...args.slice(6)], { env, stdio: 'inherit' }).status ?? 97;
}
