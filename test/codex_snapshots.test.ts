const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshotDefinitions, observeSnapshotSources } = require('../commands/backup_snapshots.ts');
const { checkedPath, fileEntry, readBoundedFile, recursiveFiles, reviewRecursiveFiles, recursiveSnapshot, snapshotByteLimit, SnapshotLimitError, SnapshotCwdError, sourceStat } = require('../commands/recursive_snapshot.ts');
const { readDirectorySnapshot } = require('../commands/directory_snapshot.ts');
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

  it('reports logical active-home aliases while collecting from canonical paths', () => {
    const active = path.join(homeDir, 'active codex');
    write('config.toml', 'synthetic alias config', active);
    write('rules/nested/rule', 'synthetic alias rule', active);
    const alias = path.join(homeDir, 'active alias');
    fs.symlinkSync(active, alias);
    const raw = discover('codex_config.toml', { CODEX_HOME: alias });
    const recursive = discover('codex_rules.bundle.json', { CODEX_HOME: alias });
    assert.equal(raw.status, 'available');
    assert.equal(recursive.status, 'available');
    if (raw.status !== 'available' || recursive.status !== 'available') throw new Error('Expected synthetic alias sources');
    assert.equal(raw.source.path, path.join(alias, 'config.toml'));
    assert.equal(raw.source.root, alias);
    assert.deepEqual(raw.collector.args, [collectorPath, active, 'file', 'config.toml']);
    assert.equal(recursive.source.path, path.join(alias, 'rules'));
    assert.deepEqual(recursive.collector.args, [collectorPath, path.join(active, 'rules'), 'directory']);
  });

  it('reports missing, empty, generated-only and wrong-type sources distinctly', () => {
    assert.equal(discover('codex_config.toml').status, 'absent');
    assert.equal(discover('codex_skills.bundle.json').status, 'absent');
    fs.mkdirSync(path.join(root, 'skills'));
    assert.equal(discover('codex_skills.bundle.json').status, 'absent');
    write('skills/.system/generated/SKILL.md');
    write('skills/.DS_Store');
    assert.equal(discover('codex_skills.bundle.json').status, 'absent');
    write('sessions/session.jsonl');
    write('auth.json');
    write('history.jsonl');
    assert.equal(discover('codex_profiles.bundle.json').status, 'absent');
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
      assert.equal(discover('codex_profiles.bundle.json').status, 'available');
      assert.deepEqual(recursiveFiles(root, true), ['a.config.toml', 'z.config.toml']);
    } finally { fs.lstatSync = original; }
    const result = capture('codex_profiles.bundle.json');
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
      'codex_AGENTS.md', 'codex_AGENTS.override.md', 'codex_config.toml', 'codex_profiles.bundle.json', 'codex_hooks.json',
      'codex_skills.bundle.json', 'codex_user_skills.bundle.json', 'codex_rules.bundle.json', 'codex_agents.bundle.json', 'codex_marketplace.json',
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
    assert.equal(archive.version, 2);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['a/.hidden', 'a/.system/user-owned', 'z folder/run.sh']);
    assert.equal(archive.entries[2].executable, true);
    assert.equal(archive.entries[0].executable, false);
    assert.equal(archive.entries[0].encoding, 'base64');
    assert.equal(archive.entries[2].encoding, 'utf8');
    assert.deepEqual(archive.entries[2].content, ['#!/bin/sh\n']);
    assert.deepEqual(Buffer.from(archive.entries[0].content, 'base64'), Buffer.from([0, 255, 128, 10]));
    ['rules', 'agents'].forEach((directory) => {
      write(`${directory}/nested/.system/user`, 'retained');
      assert.equal(capture(`codex_${directory}.bundle.json`).status, 0);
    });
  });

  for (const name of ['codex_skills.bundle.json', 'codex_user_skills.bundle.json']) {
    it(`omits standard OpenAI skill metadata while preserving resources in ${name}`, () => {
      const active = path.join(homeDir, 'active codex');
      const skillRoot = name === 'codex_skills.bundle.json' ? path.join(active, 'skills') : path.join(homeDir, '.agents/skills');
      const files = new Map<string, Buffer>([
        ['demo/SKILL.md', Buffer.from('# Synthetic skill\r\nlast')],
        ['demo/scripts/run.sh', Buffer.from('#!/bin/sh\necho synthetic\n')],
        ['demo/references/guide.md', Buffer.from('Synthetic reference\n')],
        ['demo/assets/icon.bin', Buffer.from([0, 255, 128, 10])],
        ['demo/.hidden', Buffer.from('Hidden support')],
        ['demo/agents/other.yaml', Buffer.from('keep: true\n')],
        ['demo/agents/openai.yml', Buffer.from('different extension')],
        ['demo/agents/nested/openai.yaml', Buffer.from('nested resource')],
        ['demo/references/agents/openai.yaml', Buffer.from('reference resource')],
        ['demo/openai.yaml', Buffer.from('root resource')],
        ['agents/openai.yaml', Buffer.from('tree-root resource')],
        ['case/agents/OpenAI.yaml', Buffer.from('different spelling')],
        ['directory/agents/openai.yaml/keep.txt', Buffer.from('directory contents')],
        ['binary/SKILL.md', Buffer.from('# Second synthetic skill\n')],
      ]);
      const omitted = new Map<string, Buffer>([
        ['demo/agents/openai.yaml', Buffer.from('interface:\n  display_name: Synthetic\ndependencies:\n  tools: []\npolicy:\n  allow_implicit_invocation: false\n')],
        ['binary/agents/openai.yaml', Buffer.from([0, 255, 128])],
      ]);
      for (const [relative, bytes] of [...files, ...omitted]) write(relative, bytes, skillRoot);
      const script = path.join(skillRoot, 'demo/scripts/run.sh');
      fs.chmodSync(script, 0o755);
      const env = { CODEX_HOME: active };
      const expected = [...files.keys()].sort();
      assert.deepEqual(recursiveFiles(skillRoot, false, true), expected);
      assert.deepEqual(reviewRecursiveFiles(skillRoot, false, true), expected);
      const result = capture(name, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(capture(name, env).stdout, result.stdout);
      const { version, entries } = readDirectorySnapshot(Buffer.from(result.stdout));
      assert.equal(version, 2);
      assert.deepEqual(entries.map((entry: { path: string }) => entry.path), expected);
      for (const entry of entries) {
        assert.deepEqual(entry.bytes, files.get(entry.path), entry.path);
        assert.equal(entry.executable, entry.path === 'demo/scripts/run.sh', entry.path);
      }
      for (const [relative, bytes] of [...files, ...omitted]) assert.deepEqual(fs.readFileSync(path.join(skillRoot, relative)), bytes);
      assert.equal(fs.statSync(script).mode & 0o777, 0o755);
    });
  }

  it('skips metadata-only skills without opening metadata and still counts visited entries', () => {
    const skillRoot = path.join(root, 'skills');
    write('skills/demo/agents/openai.yaml', 'not: [valid YAML');
    const originalOpen = fs.openSync;
    try {
      fs.openSync = () => { throw new Error('Excluded metadata must not be opened'); };
      assert.equal(discover('codex_skills.bundle.json').status, 'absent');
      assert.deepEqual(reviewRecursiveFiles(skillRoot, false, true), []);
      assert.throws(() => recursiveSnapshot(skillRoot, false, true), /no regular files/);
    } finally { fs.openSync = originalOpen; }
    assert.deepEqual(recursiveFiles(skillRoot, false, true, { maxEntries: 3 }), []);
    assert.throws(() => recursiveFiles(skillRoot, false, true, { maxEntries: 2 }), SnapshotLimitError);
    assert.equal(fs.readFileSync(path.join(skillRoot, 'demo/agents/openai.yaml'), 'utf8'), 'not: [valid YAML');
  });

  for (const directory of ['rules', 'agents']) {
    it(`preserves OpenAI YAML paths outside Codex skill sources: ${directory}`, () => {
      const content = 'synthetic: retained\n';
      write(`${directory}/demo/agents/openai.yaml`, content);
      const result = capture(`codex_${directory}.bundle.json`);
      assert.equal(result.status, 0, result.stderr);
      const { entries } = readDirectorySnapshot(Buffer.from(result.stdout));
      assert.deepEqual(entries.map((entry: { path: string }) => entry.path), ['demo/agents/openai.yaml']);
      assert.deepEqual(entries[0].bytes, Buffer.from(content));
    });
  }

  it('does not follow descendant or top-level file symlinks', () => {
    write('outside', 'outside', homeDir);
    write('rules/regular', 'regular');
    fs.symlinkSync(path.join(homeDir, 'outside'), path.join(root, 'rules/link'));
    fs.symlinkSync(homeDir, path.join(root, 'rules/directory-link'));
    assert.deepEqual(recursiveFiles(path.join(root, 'rules')), ['regular']);
    fs.symlinkSync(path.join(homeDir, 'outside'), path.join(root, 'config.toml'));
    assert.equal(discover('codex_config.toml').status, 'unavailable');
    let symlinkFailure: NodeJS.ErrnoException | undefined;
    try { fileEntry(root, 'config.toml'); } catch (error) { symlinkFailure = error as NodeJS.ErrnoException; }
    assert.equal(symlinkFailure?.code, 'ELOOP');
    assert.throws(() => checkedPath(root, '../outside'), /Invalid snapshot path/);
    assert.throws(() => checkedPath(root, path.join(homeDir, 'outside')), /Invalid snapshot path/);
    const alias = path.join(homeDir, 'root-alias');
    fs.symlinkSync(root, alias);
    assert.throws(() => checkedPath(alias, '.'), /Symlinked snapshot source/);
  });

  it('reports source access failures without pretending the source is absent', () => {
    write('config.toml');
    const original = fs.lstatSync;
    try {
      fs.lstatSync = (candidate: string) => {
        if (path.resolve(candidate) === path.join(root, 'config.toml')) throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' });
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
        if (candidate === '.' && process.cwd() === path.join(root, 'rules/nested')) throw Object.assign(new Error('synthetic directory failure'), { code: 'EACCES' });
        return original(candidate);
      };
      assert.equal(discover('codex_rules.bundle.json').status, 'discovery-failed');
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
      const result = discover('codex_profiles.bundle.json');
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

  it('reads the held parent after an ancestor is replaced at leaf open', () => {
    write('rules/nested/entry', 'inside approved');
    const outside = path.join(homeDir, 'outside');
    write('entry', 'OUTSIDE_SYNTHETIC_SECRET', outside);
    const nested = path.join(root, 'rules/nested');
    const originalOpen = fs.openSync;
    const previous = process.cwd();
    let swapped = false;
    try {
      fs.openSync = (candidate: string, flags: number) => {
        if (candidate === 'entry' && !swapped) {
          swapped = true;
          fs.renameSync(nested, `${nested}-original`);
          fs.symlinkSync(outside, nested);
        }
        return originalOpen(candidate, flags);
      };
      const entry = fileEntry(root, 'rules/nested/entry');
      assert.isTrue(swapped);
      assert.equal(Buffer.from(entry.content, 'base64').toString(), 'inside approved');
      assert.equal(process.cwd(), previous);
    } finally { fs.openSync = originalOpen; }
  });

  it('rejects replacement before directory entry and rename before verification', () => {
    ['before-entry', 'before-verification'].forEach((phase) => {
      const nested = path.join(root, phase);
      write(`${phase}/entry`, 'inside');
      const outside = path.join(homeDir, `outside-${phase}`);
      write('entry', 'outside', outside);
      const originalChdir = process.chdir;
      let swapped = false;
      try {
        process.chdir = (candidate: string) => {
          if (candidate === phase && !swapped) {
            swapped = true;
            if (phase === 'before-verification') originalChdir(candidate);
            fs.renameSync(nested, `${nested}-original`);
            fs.symlinkSync(outside, nested);
            if (phase === 'before-verification') return;
          }
          return originalChdir(candidate);
        };
        assert.throws(() => fileEntry(root, `${phase}/entry`), /Snapshot directory changed/);
        assert.isTrue(swapped);
      } finally { process.chdir = originalChdir; }
    });
  });

  it('enumerates the held directory after its path is replaced', () => {
    write('rules/inside', 'inside');
    const directory = path.join(root, 'rules');
    const outside = path.join(homeDir, 'outside');
    write('OUTSIDE_NAME', 'outside', outside);
    const originalOpen = fs.opendirSync;
    let swapped = false;
    try {
      fs.opendirSync = (candidate: string) => {
        if (candidate === '.' && process.cwd() === directory && !swapped) {
          swapped = true;
          fs.renameSync(directory, `${directory}-original`);
          fs.symlinkSync(outside, directory);
        }
        return originalOpen(candidate);
      };
      assert.deepEqual(recursiveFiles(directory), ['inside']);
      assert.isTrue(swapped);
    } finally { fs.opendirSync = originalOpen; }
  });

  it('rejects a leaf replaced with a symlink at actual open', () => {
    const leaf = write('entry', 'inside');
    const outside = write('outside', 'outside', homeDir);
    const originalOpen = fs.openSync;
    let swapped = false;
    try {
      fs.openSync = (candidate: string, flags: number) => {
        if (candidate === 'entry' && !swapped) {
          swapped = true;
          fs.unlinkSync(leaf);
          fs.symlinkSync(outside, leaf);
        }
        return originalOpen(candidate, flags);
      };
      assert.throws(() => fileEntry(root, 'entry'));
      assert.isTrue(swapped);
    } finally { fs.openSync = originalOpen; }
  });

  it('restores caller directory on success and failure and reports restoration failures', () => {
    const caller = path.join(homeDir, 'caller');
    fs.mkdirSync(caller);
    write('entry');
    const previous = process.cwd();
    const originalChdir = process.chdir;
    try {
      process.chdir(caller);
      const inode = fs.statSync('.').ino;
      fileEntry(root, 'entry');
      assert.equal(process.cwd(), caller);
      assert.equal(fs.statSync('.').ino, inode);
      assert.throws(() => fileEntry(root, 'entry', 0), SnapshotLimitError);
      assert.equal(process.cwd(), caller);
      assert.equal(fs.statSync('.').ino, inode);
      process.chdir = (candidate: string) => {
        if (candidate === caller) throw new Error('synthetic restoration failure');
        return originalChdir(candidate);
      };
      assert.throws(() => fileEntry(root, 'entry'), SnapshotCwdError);
      process.chdir = originalChdir;
      process.chdir(caller);
      const originalOpen = fs.openSync;
      try {
        fs.openSync = (candidate: string, flags: number) => {
          if (candidate === 'entry') {
            fs.renameSync(caller, `${caller}-original`);
            fs.mkdirSync(caller);
          }
          return originalOpen(candidate, flags);
        };
        assert.throws(() => fileEntry(root, 'entry'), SnapshotCwdError);
      } finally { fs.openSync = originalOpen; }
    } finally { process.chdir = originalChdir; process.chdir(previous); }
  });

  it('keeps CLI raw capture inside the held root during an ancestor replacement', () => {
    write('config.toml', 'ORIGINAL_INSIDE_BYTES');
    const outside = path.join(homeDir, 'outside');
    write('config.toml', 'OUTSIDE_SYNTHETIC_SECRET', outside);
    const preload = write('capture-preload.cjs', `
      const fs = require('fs');
      const open = fs.openSync;
      let swapped = false;
      fs.openSync = (candidate, flags, ...args) => {
        if (candidate === 'config.toml' && !swapped) {
          swapped = true;
          fs.renameSync(process.env.SYNTHETIC_INSIDE, process.env.SYNTHETIC_INSIDE + '-original');
          fs.symlinkSync(process.env.SYNTHETIC_OUTSIDE, process.env.SYNTHETIC_INSIDE);
        }
        return open(candidate, flags, ...args);
      };
    `, homeDir);
    const result = spawnSync(process.execPath, ['--require', preload, collectorPath, root, 'file', 'config.toml'], {
      env: { HOME: homeDir, PATH: '', SYNTHETIC_INSIDE: root, SYNTHETIC_OUTSIDE: outside }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ORIGINAL_INSIDE_BYTES');
    assert.notInclude(result.stdout, 'OUTSIDE_SYNTHETIC_SECRET');
    assert.equal(fs.readlinkSync(root), outside);
  });

  it('rejects a CLI root replacement before entry without returning outside bytes', () => {
    write('config.toml', 'ORIGINAL_INSIDE_BYTES');
    const outside = path.join(homeDir, 'outside');
    write('config.toml', 'OUTSIDE_SYNTHETIC_SECRET', outside);
    const preload = write('entry-preload.cjs', `
      const fs = require('fs');
      const path = require('path');
      const chdir = process.chdir;
      let swapped = false;
      process.chdir = (candidate) => {
        if (candidate === path.basename(process.env.SYNTHETIC_INSIDE) && !swapped) {
          swapped = true;
          fs.renameSync(process.env.SYNTHETIC_INSIDE, process.env.SYNTHETIC_INSIDE + '-original');
          fs.symlinkSync(process.env.SYNTHETIC_OUTSIDE, process.env.SYNTHETIC_INSIDE);
        }
        return chdir(candidate);
      };
    `, homeDir);
    const result = spawnSync(process.execPath, ['--require', preload, collectorPath, root, 'file', 'config.toml'], {
      env: { HOME: homeDir, PATH: '', SYNTHETIC_INSIDE: root, SYNTHETIC_OUTSIDE: outside }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to capture recursive snapshot.\n');
    assert.equal(fs.readlinkSync(root), outside);
  });

  it('inspects only held-parent metadata if its ancestor changes before final lstat', () => {
    write('rules/nested/entry', 'inside');
    const nested = path.join(root, 'rules/nested');
    const insideStat = fs.lstatSync(path.join(nested, 'entry'));
    const outside = path.join(homeDir, 'outside');
    write('entry', 'OUTSIDE_DIFFERENT_LENGTH', outside);
    const originalStat = fs.lstatSync;
    const originalRead = fs.readSync;
    let swapped = false;
    let reads = 0;
    try {
      fs.lstatSync = (candidate: string) => {
        if (candidate === 'entry' && !swapped) {
          swapped = true;
          fs.renameSync(nested, `${nested}-original`);
          fs.symlinkSync(outside, nested);
        }
        return originalStat(candidate);
      };
      fs.readSync = (...args: unknown[]) => { reads++; return originalRead(...args); };
      const captured = sourceStat(root, 'rules/nested/entry');
      assert.isTrue(swapped);
      assert.equal(captured.ino, insideStat.ino);
      assert.equal(captured.size, insideStat.size);
      assert.equal(reads, 0);
    } finally { fs.lstatSync = originalStat; fs.readSync = originalRead; }
  });

  it('keeps unreadable leaves available in metadata discovery but fails review and capture', () => {
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const previous = process.cwd();
    const previousStat = fs.statSync('.');
    const cases = [
      { name: 'codex_skills.bundle.json', relative: 'skills/leaf', directory: 'skills', profiles: false, skills: true },
      { name: 'codex_rules.bundle.json', relative: 'rules/leaf', directory: 'rules', profiles: false, skills: false },
      { name: 'codex_agents.bundle.json', relative: 'agents/leaf', directory: 'agents', profiles: false, skills: false },
      { name: 'codex_profiles.bundle.json', relative: 'guard.config.toml', directory: '.', profiles: true, skills: false },
    ];
    cases.forEach(({ relative }) => write(relative, 'SYNTHETIC_UNREADABLE_CONTENT'));
    let opens = 0;
    let reads = 0;
    try {
      fs.openSync = (candidate: string, flags: number) => {
        if (['leaf', 'guard.config.toml'].includes(path.basename(candidate))) {
          opens++;
          throw Object.assign(new Error('synthetic unreadable leaf'), { code: 'EACCES' });
        }
        return originalOpen(candidate, flags);
      };
      fs.readSync = (...args: unknown[]) => { reads++; return originalRead(...args); };
      cases.forEach(({ name, directory, profiles, skills }) => {
        const sourceRoot = path.join(root, directory);
        assert.equal(discover(name).status, 'available');
        assert.isNotEmpty(recursiveFiles(sourceRoot, profiles, skills));
        assert.equal(opens, 0);
        assert.equal(reads, 0);
      });
      cases.forEach(({ directory, profiles, skills }) => {
        const sourceRoot = path.join(root, directory);
        for (const operation of [() => reviewRecursiveFiles(sourceRoot, profiles, skills), () => recursiveSnapshot(sourceRoot, profiles, skills)]) {
          let failure: NodeJS.ErrnoException | undefined;
          try { operation(); } catch (error) { failure = error as NodeJS.ErrnoException; }
          assert.equal(failure?.code, 'EACCES');
        }
        assert.equal(process.cwd(), previous);
        const restored = fs.statSync('.');
        assert.equal(restored.ino, previousStat.ino);
        assert.equal(restored.dev, previousStat.dev);
      });
      assert.equal(opens, 8);
      assert.equal(reads, 0);
    } finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  });

  it('preserves override instructions independently from ordinary instructions and active-home precedence', () => {
    write('AGENTS.override.md', 'synthetic override');
    assert.equal(discover('codex_AGENTS.md').status, 'absent');
    assert.equal(capture('codex_AGENTS.override.md').stdout, 'synthetic override');
    write('AGENTS.md', 'synthetic ordinary');
    assert.equal(capture('codex_AGENTS.md').stdout, 'synthetic ordinary');
    assert.equal(capture('codex_AGENTS.override.md').stdout, 'synthetic override');
    const active = path.join(homeDir, 'custom codex');
    write('AGENTS.override.md', 'synthetic custom override', active);
    assert.equal(capture('codex_AGENTS.override.md', { CODEX_HOME: active }).stdout, 'synthetic custom override');
    const observed = observeSnapshotSources({ homeDir, env: { PATH: '' } }, false);
    const override = observed.find(({ definition }: { definition: SnapshotDefinition }) => definition.name === 'codex_AGENTS.override.md');
    assert.exists(override);
    assert.equal(override!.status, 'excluded-by-policy');
  });

  it('rejects symlinked override instructions and enforces their raw byte budget', () => {
    const outside = write('outside', 'synthetic outside', homeDir);
    fs.symlinkSync(outside, path.join(root, 'AGENTS.override.md'));
    assert.equal(discover('codex_AGENTS.override.md').status, 'unavailable');
    fs.unlinkSync(path.join(root, 'AGENTS.override.md'));
    write('AGENTS.override.md', 'abcd');
    const result = spawnSync(process.execPath, [collectorPath, root, 'file', 'AGENTS.override.md', '--max-bytes', '3'], {
      env: { HOME: homeDir, PATH: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Snapshot bytes limit exceeded (4 > 3).\n');
  });

  it('preserves both canonical skill origins when their selected directories overlap', () => {
    write('.agents/skills/demo/SKILL.md', 'synthetic overlap', homeDir);
    const env = { CODEX_HOME: path.join(homeDir, '.agents') };
    const legacy = discover('codex_skills.bundle.json', env);
    const current = discover('codex_user_skills.bundle.json', env);
    assert.equal(legacy.status, 'available');
    assert.equal(current.status, 'available');
    if (legacy.status !== 'available' || current.status !== 'available') throw new Error('Expected both skill origins');
    assert.equal(legacy.source.path, current.source.path);
    assert.notEqual(legacy.collector.fileName, current.collector.fileName);
    assert.equal(capture('codex_skills.bundle.json', env).stdout, capture('codex_user_skills.bundle.json', env).stdout);
  });

  it('captures fixed home user skills independently of the active Codex skills root', () => {
    write('.agents/skills/nested/.hidden', Buffer.from([0, 255, 128]), homeDir);
    const executable = write('.agents/skills/nested/run.sh', '#!/bin/sh\n', homeDir);
    fs.chmodSync(executable, 0o755);
    write('.agents/skills/.system/generated', 'excluded', homeDir);
    write('.agents/skills/nested/.system/user', 'retained', homeDir);
    write('skills/default', 'default Codex skill');
    const active = path.join(homeDir, 'active codex');
    write('skills/custom', 'custom Codex skill', active);
    const defaultSkills = JSON.parse(capture('codex_skills.bundle.json').stdout);
    assert.deepEqual(defaultSkills.entries.map((entry: { path: string }) => entry.path), ['default']);
    const customSkills = JSON.parse(capture('codex_skills.bundle.json', { CODEX_HOME: active }).stdout);
    assert.deepEqual(customSkills.entries.map((entry: { path: string }) => entry.path), ['custom']);
    const user = capture('codex_user_skills.bundle.json');
    assert.equal(user.status, 0, user.stderr);
    assert.equal(capture('codex_user_skills.bundle.json', { CODEX_HOME: active }).stdout, user.stdout);
    const archive = JSON.parse(user.stdout);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['nested/.hidden', 'nested/.system/user', 'nested/run.sh']);
    assert.deepEqual(Buffer.from(archive.entries[0].content, 'base64'), Buffer.from([0, 255, 128]));
    assert.isTrue(archive.entries[2].executable);
    const definition = (snapshotDefinitions as SnapshotDefinition[]).find(({ name }) => name === 'codex_user_skills.bundle.json')!;
    const originalDiscover = definition.discover;
    try {
      definition.discover = () => { throw new Error('Excluded user skills must not be inspected'); };
      const observations = observeSnapshotSources({ homeDir, env: { PATH: '', CODEX_HOME: active } }, false);
      assert.equal(observations.find(({ definition: entry }: { definition: SnapshotDefinition }) => entry.name === definition.name)!.status, 'excluded-by-policy');
    } finally { definition.discover = originalDiscover; }
  });

  it('rejects symlinked home skills ancestors and skips descendant symlinks', () => {
    const outside = path.join(homeDir, 'outside');
    write('skill', 'outside', outside);
    fs.symlinkSync(outside, path.join(homeDir, '.agents'));
    assert.equal(discover('codex_user_skills.bundle.json').status, 'unavailable');
    fs.unlinkSync(path.join(homeDir, '.agents'));
    fs.mkdirSync(path.join(homeDir, '.agents'));
    fs.symlinkSync(outside, path.join(homeDir, '.agents/skills'));
    assert.equal(discover('codex_user_skills.bundle.json').status, 'unavailable');
    fs.unlinkSync(path.join(homeDir, '.agents/skills'));
    write('.agents/skills/inside', 'inside', homeDir);
    fs.symlinkSync(outside, path.join(homeDir, '.agents/skills/outside-directory'));
    fs.symlinkSync(path.join(outside, 'skill'), path.join(homeDir, '.agents/skills/outside-file'));
    const archive = JSON.parse(capture('codex_user_skills.bundle.json').stdout);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['inside']);
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
