const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshotDefinitions } = require('../commands/backup_snapshots.ts');
const { checkedPath, fileEntry, readBoundedFile, recursiveFiles, recursiveSnapshot, snapshotByteLimit, SnapshotLimitError } = require('../commands/recursive_snapshot.ts');
import type { SnapshotDefinition } from '../commands/backup_snapshots.ts';

const collectorPath = path.resolve(__dirname, '../commands/recursive_snapshot.ts');

describe('Codex durable snapshots', () => {
  let homeDir: string;
  let root: string;
  const write = (relative: string, content: string | Buffer = 'synthetic\n', base = root): string => {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const discover = (name: string, env: NodeJS.ProcessEnv = {}) => {
    const definition = (snapshotDefinitions as SnapshotDefinition[]).find((entry) => entry.name === name);
    assert.exists(definition);
    return definition!.discover({ homeDir, env: { PATH: '', ...env } });
  };
  const capture = (name: string, env: NodeJS.ProcessEnv = {}) => {
    const source = discover(name, env);
    assert.equal(source.status, 'available');
    if (source.status !== 'available') throw new Error('Expected available synthetic source');
    return spawnSync(source.collector.command, source.collector.args, {
      env: { HOME: homeDir, PATH: '', ...env }, encoding: 'utf8',
    });
  };
  beforeEach(() => {
    homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-codex-fixture-')));
    root = path.join(homeDir, '.codex');
    fs.mkdirSync(root);
  });
  afterEach(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  it('captures complete config, hooks, and instructions without rewriting trust fields', () => {
    const fixtures = {
      'config.toml': '[projects."/synthetic/project"]\ntrust_level = "trusted"\n[hooks.state.synthetic]\ntrusted_hash = "SYNTHETIC_HASH"\nenabled = false\n',
      'hooks.json': '{"hooks":{"SessionStart":[{"command":"echo synthetic"}]}}',
      'AGENTS.md': 'Synthetic personal instructions',
    };
    Object.entries(fixtures).forEach(([relative, content]) => {
      write(relative, content);
      const result = capture(`codex_${relative}`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, content);
    });
  });

  it('uses active CODEX_HOME including aliases instead of the default home', () => {
    write('config.toml', 'default');
    const active = path.join(homeDir, 'active codex');
    write('config.toml', 'active', active);
    const alias = path.join(homeDir, 'alias');
    fs.symlinkSync(active, alias);
    [active, alias].forEach((CODEX_HOME) => {
      assert.equal(capture('codex_config.toml', { CODEX_HOME }).stdout, 'active');
    });
  });

  it('reports missing, empty, generated-only and wrong-type sources distinctly', () => {
    assert.equal(discover('codex_config.toml').status, 'absent');
    assert.equal(discover('codex_skills.json').status, 'absent');
    fs.mkdirSync(path.join(root, 'skills'));
    assert.equal(discover('codex_skills.json').status, 'absent');
    write('skills/.system/generated/SKILL.md');
    write('skills/.DS_Store');
    assert.equal(discover('codex_skills.json').status, 'absent');
    write('sessions/session.jsonl');
    write('auth.json');
    write('history.jsonl');
    assert.equal(discover('codex_profiles.json').status, 'absent');
    fs.mkdirSync(path.join(root, 'config.toml'));
    assert.equal(discover('codex_config.toml').status, 'unavailable');
  });

  it('captures only immediate named profiles without inspecting unrelated runtime entries', () => {
    write('z.config.toml', 'z');
    write('a.config.toml', 'a');
    write('.config.toml', 'not a named profile');
    write('sessions/private.config.toml', 'runtime');
    write('nested/unrelated');
    const original = fs.lstatSync;
    try {
      fs.lstatSync = (candidate: string) => {
        if (['sessions', 'nested', '.config.toml'].includes(path.basename(candidate))) {
          throw new Error('Unrelated state was inspected');
        }
        return original(candidate);
      };
      assert.equal(discover('codex_profiles.json').status, 'available');
      assert.deepEqual(recursiveFiles(root, true), ['a.config.toml', 'z.config.toml']);
    } finally { fs.lstatSync = original; }
    const result = capture('codex_profiles.json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).entries.map((entry: { path: string }) => entry.path), ['a.config.toml', 'z.config.toml']);
  });

  it('keeps project-local and marketplace referenced payloads outside the catalog', () => {
    write('.codex/config.toml', 'project-local', path.join(homeDir, 'project'));
    write('.agents/plugins/marketplace.json', '{"plugins":[{"source":"/synthetic/external"}]}', homeDir);
    write('.agents/plugins/cache/payload', 'cache', homeDir);
    write('plugins/payload', 'plugin payload');
    assert.equal(discover('codex_config.toml').status, 'absent');
    assert.equal(capture('codex_marketplace.json').stdout, '{"plugins":[{"source":"/synthetic/external"}]}');
    assert.deepEqual((snapshotDefinitions as SnapshotDefinition[]).filter(({ category }) => category === 'codex').map(({ name }) => name), [
      'codex_AGENTS.md', 'codex_config.toml', 'codex_profiles.json', 'codex_hooks.json',
      'codex_skills.json', 'codex_rules.json', 'codex_agents.json', 'codex_marketplace.json',
    ]);
  });

  it('archives recursive bytes, hidden files, executable modes and spaces deterministically', () => {
    const skillRoot = path.join(root, 'skills');
    const executable = write('skills/z folder/run.sh', '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);
    write('skills/a/.hidden', Buffer.from([0, 255, 128, 10]));
    write('skills/a/.system/user-owned', 'nested retained');
    write('skills/.system/built-in', 'excluded');
    write('skills/a/.git/config', 'excluded');
    write('skills/.DS_Store', 'excluded');
    const first = recursiveSnapshot(skillRoot, false, true);
    fs.utimesSync(executable, new Date(0), new Date(0));
    assert.equal(recursiveSnapshot(skillRoot, false, true), first);
    const archive = JSON.parse(first);
    assert.equal(archive.format, 'ballin-directory');
    assert.equal(archive.version, 1);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['a/.hidden', 'a/.system/user-owned', 'z folder/run.sh']);
    assert.equal(archive.entries[2].executable, true);
    assert.equal(archive.entries[0].executable, false);
    assert.deepEqual(Buffer.from(archive.entries[0].content, 'base64'), Buffer.from([0, 255, 128, 10]));
    ['rules', 'agents'].forEach((directory) => {
      write(`${directory}/nested/.system/user`, 'retained');
      assert.equal(capture(`codex_${directory}.json`).status, 0);
    });
  });

  it('does not follow descendant or top-level file symlinks', () => {
    write('outside', 'outside', homeDir);
    write('rules/regular', 'regular');
    fs.symlinkSync(path.join(homeDir, 'outside'), path.join(root, 'rules/link'));
    fs.symlinkSync(homeDir, path.join(root, 'rules/directory-link'));
    assert.deepEqual(recursiveFiles(path.join(root, 'rules')), ['regular']);
    fs.symlinkSync(path.join(homeDir, 'outside'), path.join(root, 'config.toml'));
    assert.equal(discover('codex_config.toml').status, 'unavailable');
    assert.throws(() => fileEntry(root, 'config.toml'), /Symlinked snapshot source/);
    assert.throws(() => checkedPath(root, '../outside'), /Invalid snapshot path/);
    assert.throws(() => checkedPath(root, path.join(homeDir, 'outside')), /Invalid snapshot path/);
    const alias = path.join(homeDir, 'root-alias');
    fs.symlinkSync(root, alias);
    assert.throws(() => checkedPath(alias, '.'), /Snapshot root changed/);
  });

  it('reports source access failures without pretending the source is absent', () => {
    write('config.toml');
    const original = fs.lstatSync;
    try {
      fs.lstatSync = (candidate: string) => {
        if (candidate === path.join(root, 'config.toml')) throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' });
        return original(candidate);
      };
      const result = discover('codex_config.toml');
      assert.equal(result.status, 'discovery-failed');
      if (result.status === 'discovery-failed') assert.equal(result.reason, 'source-access-failed');
    } finally { fs.lstatSync = original; }
  });

  it('reports recursive enumeration failures and rejects a changed ancestor', () => {
    write('rules/nested/entry');
    const original = fs.opendirSync;
    try {
      fs.opendirSync = (candidate: string) => {
        if (candidate === path.join(root, 'rules/nested')) throw Object.assign(new Error('synthetic directory failure'), { code: 'EACCES' });
        return original(candidate);
      };
      assert.equal(discover('codex_rules.json').status, 'discovery-failed');
      assert.throws(() => recursiveSnapshot(path.join(root, 'rules')), /synthetic directory failure/);
    } finally { fs.opendirSync = original; }
    const nested = path.join(root, 'rules/nested');
    fs.rmSync(nested, { recursive: true });
    fs.symlinkSync(homeDir, nested);
    assert.throws(() => checkedPath(path.join(root, 'rules'), 'nested/entry'), /Symlinked snapshot source/);
  });

  it('closes descriptors on read failures and rejects nonregular file entries', () => {
    write('config.toml');
    const originalRead = fs.readSync;
    const originalClose = fs.closeSync;
    let closed = false;
    try {
      fs.readSync = () => { throw new Error('synthetic read failure'); };
      fs.closeSync = (fd: number) => { closed = true; return originalClose(fd); };
      assert.throws(() => fileEntry(root, 'config.toml'), /synthetic read failure/);
      assert.isTrue(closed);
    } finally { fs.readSync = originalRead; fs.closeSync = originalClose; }
    fs.mkdirSync(path.join(root, 'directory'));
    assert.throws(() => fileEntry(root, 'directory'), /not a regular file/);
    assert.deepEqual(recursiveFiles(path.join(root, 'config.toml')), []);
  });

  it('accepts exact raw byte limits and rejects larger files before reading or allocating', () => {
    const file = write('binary', Buffer.from([0, 255, 128]));
    assert.deepEqual(readBoundedFile(file, 3).bytes, Buffer.from([0, 255, 128]));
    assert.deepEqual(readBoundedFile(file, 4).bytes, Buffer.from([0, 255, 128]));
    assert.throws(() => readBoundedFile(file, 2), SnapshotLimitError);
    fs.truncateSync(file, snapshotByteLimit + 1);
    const originalRead = fs.readSync;
    const originalAlloc = Buffer.alloc;
    try {
      fs.readSync = () => { throw new Error('Oversized file must not be read'); };
      Buffer.alloc = () => { throw new Error('Oversized file must not allocate content'); };
      assert.throws(() => readBoundedFile(file), SnapshotLimitError);
    } finally { fs.readSync = originalRead; Buffer.alloc = originalAlloc; }
  });

  it('counts directories and excluded entries against traversal entry limits', () => {
    fs.mkdirSync(path.join(root, 'empty'));
    fs.mkdirSync(path.join(root, '.git'));
    assert.deepEqual(recursiveFiles(root, false, false, { maxEntries: 2 }), []);
    assert.deepEqual(recursiveFiles(root, false, false, { maxEntries: 3 }), []);
    assert.throws(() => recursiveFiles(root, false, false, { maxEntries: 1 }), SnapshotLimitError);
    const original = fs.opendirSync;
    try {
      fs.opendirSync = () => {
        let count = 0;
        return { readSync: () => ++count <= 8193 ? { name: '.DS_Store' } : null, closeSync: () => {} };
      };
      const result = discover('codex_profiles.json');
      assert.equal(result.status, 'discovery-failed');
      if (result.status === 'discovery-failed') assert.equal(result.reason, 'source-limit-exceeded');
    } finally { fs.opendirSync = original; }
  });

  it('bounds serialized UTF8 metadata and base64 bytes exactly including executable modes', () => {
    const file = write('é space', Buffer.from([0, 255, 128, 1]));
    fs.chmodSync(file, 0o755);
    const archive = recursiveSnapshot(root);
    const bytes = Buffer.byteLength(archive);
    assert.isAbove(bytes, archive.length);
    assert.equal(recursiveSnapshot(root, false, false, { maxBytes: bytes }), archive);
    assert.equal(recursiveSnapshot(root, false, false, { maxBytes: bytes + 1 }), archive);
    assert.throws(() => recursiveSnapshot(root, false, false, { maxBytes: bytes - 1 }), SnapshotLimitError);
    assert.deepEqual(Buffer.from(JSON.parse(archive).entries[0].content, 'base64'), Buffer.from([0, 255, 128, 1]));
    assert.throws(() => recursiveFiles(root, false, false, { maxBytes: Buffer.byteLength('é space') - 1 }), SnapshotLimitError);
  });

  it('detects growth and truncation after open and closes every descriptor', () => {
    const file = write('changing', 'abcd');
    const originalStat = fs.fstatSync;
    const originalClose = fs.closeSync;
    ['growth', 'truncation'].forEach((change) => {
      fs.writeFileSync(file, 'abcd');
      let first = true;
      let closed = false;
      try {
        fs.fstatSync = (fd: number) => {
          const stat = originalStat(fd);
          if (first) {
            first = false;
            if (change === 'growth') fs.appendFileSync(file, 'e');
            else fs.truncateSync(file, 2);
          }
          return stat;
        };
        fs.closeSync = (fd: number) => { closed = true; return originalClose(fd); };
        assert.throws(() => readBoundedFile(file), /changed during capture/);
        assert.isTrue(closed);
      } finally { fs.fstatSync = originalStat; fs.closeSync = originalClose; }
    });
  });

  it('closes directory handles when iterative enumeration fails', () => {
    const original = fs.opendirSync;
    let closed = false;
    try {
      fs.opendirSync = () => ({
        readSync: () => { throw new Error('synthetic entry read failure'); },
        closeSync: () => { closed = true; },
      });
      assert.throws(() => recursiveFiles(root), /synthetic entry read failure/);
      assert.isTrue(closed);
    } finally { fs.opendirSync = original; }
  });

  it('preserves every file in deeply nested iterative traversal', () => {
    let relative = '';
    const expected: string[] = [];
    for (let depth = 0; depth < 80; depth++) {
      relative = path.join(relative, 'd');
      const file = path.join(relative, 'entry');
      expected.push(file);
      write(file, String(depth));
    }
    assert.deepEqual(recursiveFiles(root), expected.sort());
    assert.lengthOf(JSON.parse(recursiveSnapshot(root)).entries, 80);
  });

  it('returns safe byte-budget errors without partial collector output', () => {
    write('SYNTHETIC_SECRET', 'abcd');
    const result = spawnSync(process.execPath, [collectorPath, root, 'file', 'SYNTHETIC_SECRET', '--max-bytes', '3'], {
      env: { HOME: homeDir, PATH: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Snapshot bytes limit exceeded (4 > 3).\n');
    assert.notInclude(result.stderr, homeDir);
    assert.notInclude(result.stderr, 'SYNTHETIC_SECRET');
  });

  it('fails empty or invalid captures with safe diagnostics and no stdout', () => {
    [ [root, 'directory'], [root, 'file', 'missing-SYNTHETIC_SECRET'], [root, 'file', '../outside'] ].forEach((args) => {
      const result = spawnSync(process.execPath, [collectorPath, ...args], {
        env: { HOME: homeDir, PATH: '' }, encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Unable to capture recursive snapshot.\n');
      assert.notInclude(result.stderr, homeDir);
      assert.notInclude(result.stderr, 'SYNTHETIC_SECRET');
    });
    assert.throws(() => recursiveSnapshot(root), /no regular files/);
  });
});
