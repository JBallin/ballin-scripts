// Run the actual privileged installation body with fixed commands and /tmp paths
// replaced before execution. No sudo, host marker or real softwareupdate runs.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const root = process.env.FAKE_ROOT;
if (!root) throw new Error('CLT installation requires an isolated root');
const marker = path.join(root, 'clt-marker');
const log = (text: string): void => fs.appendFileSync(path.join(root, 'commands.log'), text + '\n');
const runCommand = (name: string, args: string[]): number => {
  log(`clt-${name}:${args.join(' ')}`);
  if (name === 'mktemp') {
    assert.deepEqual(args, ['-d', path.join(root, 'tmp/ballin-clt.XXXXXX')]);
    if (process.env.FAKE_CLT_CREATE_FAIL === 'mktemp') return 71;
    process.stdout.write(fs.mkdtempSync(path.join(root, 'tmp/ballin-clt.')) + '\n');
  } else if (name === 'link') {
    assert.match(args[0], new RegExp('^' + root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '/tmp/ballin-clt\\.[^/]+/marker$'));
    assert.equal(args[1], marker);
    assert.equal(args.length, 2);
    if (process.env.FAKE_CLT_CREATE_FAIL === 'link') return 72;
    if (process.env.FAKE_CLT_CREATE_FAIL === 'race') fs.writeFileSync(marker, 'another installer\n');
    // Exercise link(1) itself, with both arguments validated inside the fixture.
    const linked = spawnSync('/bin/link', args, { env: { PATH: '/usr/bin:/bin' }, stdio: 'inherit' });
    if (linked.status !== 0) return linked.status ?? 97;
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    if (process.env.FAKE_CLT_CANCEL_AFTER_LINK) process.kill(process.ppid, process.env.FAKE_CLT_CANCEL_AFTER_LINK);
  } else if (name === 'softwareupdate') {
    assert.equal(fs.statSync(marker).isFile(), true);
    assert.equal(fs.lstatSync(marker).isSymbolicLink(), false);
    if (args[0] === '--install') {
      assert.equal(args.length, 2);
      assert.ok(['Command Line Tools for Xcode-16.4', 'Command Line Tools for Xcode 27.0-27.0'].includes(args[1]));
      log('clt-marker-present-during-install');
      process.stdout.write('Native CLT installation progress\n');
      const result = process.env.FAKE_CLT_INSTALL_RESULT;
      if (result === 'HUP' || result === 'INT' || result === 'TERM') {
        process.kill(process.ppid, 'SIG' + result); return 0;
      }
      if (result) return Number(result);
      if (process.env.FAKE_CLT_MODE === 'failed') return 42;
      if (process.env.FAKE_CLT_MODE === 'interrupt') return 130;
      if (process.env.FAKE_CLT_MODE !== 'unusable') fs.writeFileSync(path.join(root, 'git-installed'), '1');
      return 0;
    }
    assert.deepEqual(args, ['--list']);
    log('clt-marker-present-during-list');
    const result = process.env.FAKE_CLT_DISCOVERY_RESULT;
    if (result === 'HUP' || result === 'INT' || result === 'TERM') {
      process.kill(process.ppid, 'SIG' + result); return 0;
    }
    if (result) {
      process.stdout.write('  * Label: Command Line Tools for Xcode-16.4\n');
      return Number(result);
    }
    if (process.env.FAKE_CLT_REPLACE_MARKER === '1') {
      fs.unlinkSync(marker); fs.writeFileSync(marker, 'replacement marker\n');
    }
    return spawnSync(path.join(root, 'tools/softwareupdate'), args, { env: process.env, stdio: 'inherit' }).status ?? 97;
  } else if (name === 'awk') {
    return spawnSync('/usr/bin/awk', args, { env: { PATH: '/usr/bin:/bin' }, stdio: 'inherit' }).status ?? 97;
  } else if (name === 'rm') {
    if (args[0] === '-f') {
      assert.deepEqual(args, ['-f', '--', marker]);
      if (process.env.FAKE_CLT_CLEANUP_FAIL === '1') return 73;
      fs.unlinkSync(marker);
      fs.writeFileSync(path.join(root, 'clt-cleaned'), '1');
    } else {
      assert.equal(args.length, 3);
      assert.deepEqual(args.slice(0, 2), ['-rf', '--']);
      assert.equal(path.dirname(args[2]), path.join(root, 'tmp'));
      assert.match(path.basename(args[2]), /^ballin-clt\.[^/]+$/u);
      fs.rmSync(args[2], { recursive: true });
    }
  } else throw new Error('Unexpected CLT discovery command');
  return 0;
};

if (process.argv[2] === '--command') {
  process.exitCode = runCommand(process.argv[3], process.argv.slice(4));
} else {
  const args = process.argv.slice(2);
  assert.equal(args.length, 7);
  assert.deepEqual(args.slice(0, 5), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '/bin/bash', '-c']);
  assert.equal(args[6], 'ballin-clt-install');
  if (process.env.FAKE_CLT_SUDO_STATUS) process.exit(Number(process.env.FAKE_CLT_SUDO_STATUS));
  const commands = path.join(root, 'clt-commands');
  fs.mkdirSync(commands);
  const quote = (text: string): string => "'" + text.replace(/'/gu, "'\\''") + "'";
  let body = args[5];
  for (const [name, executable, count] of [
    ['mktemp', '/usr/bin/mktemp', 1], ['link', '/bin/link', 1],
    ['softwareupdate', '/usr/sbin/softwareupdate', 2], ['rm', '/bin/rm', 2], ['awk', '/usr/bin/awk', 1],
  ] as const) {
    assert.equal(body.split(executable).length - 1, count);
    const fixture = path.join(commands, name);
    fs.writeFileSync(fixture, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} --command ${name} "$@"\n`, { mode: 0o755 });
    body = body.split(executable).join(quote(fixture));
  }
  for (const [original, replacement] of [
    ['/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress', marker],
    ['/tmp/ballin-clt.XXXXXX', path.join(root, 'tmp/ballin-clt.XXXXXX')],
  ]) {
    assert.equal(body.split(original).length - 1, 1);
    body = body.replace(original, quote(replacement));
  }
  const inspected = body.split(quote(path.join(root, 'tmp/ballin-clt.XXXXXX'))).join('fixture-stage');
  assert.doesNotMatch(inspected.split(root).join('__FIXTURE_ROOT__'), /\/(?:usr|bin|private|tmp)\//u, 'No production command or protected parent may survive substitution');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FAKE_')));
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  process.exitCode = spawnSync('/bin/bash', ['-c', body, args[6]], { env, stdio: 'inherit' }).status ?? 97;
}
