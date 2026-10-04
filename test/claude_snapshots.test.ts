const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshotDefinitions, observeSnapshotSources, configurationSnapshotGroups } = require('../commands/backup_snapshots.ts');
const { recursiveFiles, reviewRecursiveFiles, recursiveSnapshot, fileEntry, SnapshotLimitError } = require('../commands/recursive_snapshot.ts');
import type { SnapshotDefinition, SnapshotSourceObservation } from '../commands/backup_snapshots.ts';

const selection = { markdownOnly: true, rejectHardlinks: true };
describe('Claude Code selected configuration', () => {
  let homeDir: string;
  let root: string;
  const write = (relative: string, content: string | Buffer = 'synthetic\n', base = root): string => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const discover = (name: string, env: NodeJS.ProcessEnv = {}) => {
    const definition = (snapshotDefinitions as SnapshotDefinition[]).find((entry) => entry.name === name)!;
    return definition.discover({ homeDir, env: { HOME: homeDir, PATH: '', ...env } });
  };
  const capture = (name: string, env: NodeJS.ProcessEnv = {}, extra: string[] = []) => {
    const observation = discover(name, env);
    assert.equal(observation.status, 'available');
    if (observation.status !== 'available') throw new Error('Expected available fixture');
    return spawnSync(observation.collector.command, [...observation.collector.args!, ...extra], {
      env: observation.collector.env, encoding: 'utf8',
    });
  };
  beforeEach(() => {
    homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-claude-fixture-')));
    root = path.join(homeDir, '.claude');
    fs.mkdirSync(root);
  });
  afterEach(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  it('uses four canonical sensitive definitions and no implicit additional source', () => {
    const definitions = (snapshotDefinitions as SnapshotDefinition[]).filter(({ category }) => category === 'claude');
    assert.deepEqual(definitions.map(({ name }) => name), ['claude_instructions', 'claude_rules.bundle.json', 'claude_agents.bundle.json', 'claude_commands.bundle.json']);
    assert.deepEqual([...configurationSnapshotGroups].filter(([, category]) => category === 'claude').map(([name]) => name), definitions.map(({ name }) => name));
    definitions.forEach(({ inclusionGroup }) => assert.equal(inclusionGroup, 'sensitive'));
  });

  [false, true].forEach((included) => {
    it(`applies maintained-catalog consent before Claude discovery (${included})`, () => {
      const definitions = snapshotDefinitions as SnapshotDefinition[];
      const originals = definitions.map(({ discover }) => discover);
      const calls: string[] = [];
      try {
        definitions.forEach((definition) => {
          definition.discover = () => {
            calls.push(definition.name);
            return { status: 'absent', reason: 'source-not-found', source: { kind: 'file', name: 'fixture' } };
          };
        });
        const observations: SnapshotSourceObservation[] = observeSnapshotSources({ homeDir, env: { PATH: '' } }, included);
        observations.filter(({ definition }) => definition.category === 'claude').forEach(({ definition, status }) => {
          assert.equal(calls.includes(definition.name), included);
          assert.equal(status, included ? 'absent' : 'excluded-by-policy');
        });
      } finally { definitions.forEach((definition, index) => { definition.discover = originals[index]; }); }
    });
  });

  it('captures whole instructions without executing or importing referenced content', () => {
    const content = '@../outside.md\nSynthetic API token: DUMMY_SECRET\n!touch /synthetic/never-execute\n';
    write('CLAUDE.md', content);
    write('outside.md', 'DUMMY_EXTERNAL_SECRET', homeDir);
    const result = capture('claude_instructions');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, content);
    assert.notInclude(result.stdout, 'DUMMY_EXTERNAL_SECRET');
  });

  it('uses the active root and discloses a root alias without selecting other roots', () => {
    write('CLAUDE.md', 'default');
    const active = path.join(homeDir, 'active Claude');
    write('CLAUDE.md', 'active', active);
    write('rules/nested/rule.md', 'active rule', active);
    const alias = path.join(homeDir, 'alias');
    fs.symlinkSync(active, alias);
    [active, alias].forEach((CLAUDE_CONFIG_DIR) => {
      assert.equal(capture('claude_instructions', { CLAUDE_CONFIG_DIR }).stdout, 'active');
      const observation = discover('claude_rules.bundle.json', { CLAUDE_CONFIG_DIR });
      assert.equal(observation.status, 'available');
      if (observation.status !== 'available') throw new Error('Expected available alias');
      assert.equal(observation.source.path, path.join(CLAUDE_CONFIG_DIR, 'rules'));
      assert.equal(observation.collector.args![1], path.join(active, 'rules'));
    });
    assert.equal(capture('claude_instructions', { CLAUDE_CONFIG_DIR: '' }).stdout, 'default');
    const relative = path.relative(process.cwd(), active);
    assert.equal(capture('claude_instructions', { CLAUDE_CONFIG_DIR: relative }).stdout, 'active');
  });

  ['rules', 'agents', 'commands'].forEach((directory) => {
    it(`archives only regular Markdown in ${directory}, with stable paths and intact bytes`, () => {
      write(`${directory}/z.md`, 'last');
      const binaryMarkdown = write(`${directory}/nested/a.md`, Buffer.from([0, 255, 128]));
      fs.chmodSync(binaryMarkdown, 0o755);
      write(`${directory}/.hidden.md`, 'hidden');
      write(`${directory}/ignored.json`, 'DUMMY_EXCLUDED_SECRET');
      write(`${directory}/run.sh`, 'touch /synthetic/never-execute');
      write(`${directory}/.git/hidden.md`, 'excluded git');
      write(`${directory}/.DS_Store`, 'excluded metadata');
      const external = write('outside.md', 'DUMMY_EXTERNAL_SECRET', homeDir);
      fs.symlinkSync(external, path.join(root, directory, 'link.md'));
      fs.symlinkSync(homeDir, path.join(root, directory, 'linked-directory'));
      fs.mkdirSync(path.join(root, directory, 'empty'));
      const result = capture(`claude_${directory}`);
      assert.equal(result.status, 0, result.stderr);
      const archive = JSON.parse(result.stdout);
      assert.equal(archive.format, 'ballin-directory');
      assert.equal(archive.version, 2);
      assert.deepEqual(archive.entries.map(({ path }: { path: string }) => path), ['.hidden.md', 'nested/a.md', 'z.md']);
      assert.deepEqual(Buffer.from(archive.entries[1].content, 'base64'), Buffer.from([0, 255, 128]));
      assert.isTrue(archive.entries[1].executable);
      assert.equal(capture(`claude_${directory}`).stdout, result.stdout);
      assert.notInclude(JSON.stringify(archive), homeDir);
    });
  });

  it('preserves agent frontmatter, hooks and inline MCP text without invoking them', () => {
    const agent = '---\nname: fixture\npermissionMode: bypassPermissions\nhooks:\n  Stop: [{command: "touch /synthetic/never-execute"}]\nmcpServers: [{fixture: {url: "https://synthetic.invalid", headers: {Authorization: "DUMMY_SECRET"}}}]\n---\nSynthetic agent';
    write('agents/review.md', agent);
    const archive = JSON.parse(capture('claude_agents.bundle.json').stdout);
    assert.equal(archive.entries[0].encoding, 'utf8');
    assert.equal(archive.entries[0].content.join(''), agent);
  });

  it('does not select settings, skills, runtime, plugins or project configuration', () => {
    ['settings.json', '.claude.json', '.credentials.json', 'skills/demo/SKILL.md', 'plugins/demo/rules/secret.md',
      'projects/demo/memory/MEMORY.md', 'agent-memory/demo/MEMORY.md', 'history.jsonl'].forEach((relative) => write(relative, 'DUMMY_EXCLUDED_SECRET'));
    write('.claude.json', 'DUMMY_HOME_SECRET', homeDir);
    write('project/CLAUDE.md', 'project instructions', homeDir);
    write('project/.claude/rules/project.md', 'project rules', homeDir);
    ['claude_instructions', 'claude_rules.bundle.json', 'claude_agents.bundle.json', 'claude_commands.bundle.json'].forEach((name) => {
      assert.equal(discover(name).status, 'absent');
    });
  });

  it('reports empty, non-Markdown-only, missing and wrong-type sources distinctly', () => {
    assert.equal(discover('claude_rules.bundle.json').status, 'absent');
    write('rules/ignored.json');
    assert.equal(discover('claude_rules.bundle.json').status, 'absent');
    fs.mkdirSync(path.join(root, 'CLAUDE.md'));
    assert.equal(discover('claude_instructions').status, 'unavailable');
    write('agents');
    assert.equal(discover('claude_agents.bundle.json').status, 'unavailable');
    fs.symlinkSync(path.join(root, 'rules'), path.join(root, 'commands'));
    assert.equal(discover('claude_commands.bundle.json').status, 'unavailable');
  });

  it('rejects selected hard links without searching their other locations', () => {
    const outside = write('outside.md', 'DUMMY_EXTERNAL_SECRET', homeDir);
    fs.linkSync(outside, path.join(root, 'CLAUDE.md'));
    assert.equal(discover('claude_instructions').status, 'discovery-failed');
    fs.mkdirSync(path.join(root, 'rules'));
    fs.linkSync(outside, path.join(root, 'rules', 'linked.md'));
    assert.equal(discover('claude_rules.bundle.json').status, 'discovery-failed');
    assert.throws(() => fileEntry(root, 'CLAUDE.md', undefined, true), /Hard-linked/);
    // The existing Codex policy remains unchanged.
    assert.equal(fileEntry(root, 'CLAUDE.md').content, Buffer.from('DUMMY_EXTERNAL_SECRET').toString('base64'));
  });

  it('counts entries before Markdown filtering and fails bounded archives without partial output', () => {
    write('rules/selected.md', 'abcd');
    write('rules/ignored.json');
    const directory = path.join(root, 'rules');
    assert.throws(() => recursiveFiles(directory, false, false, { maxEntries: 1 }, selection), SnapshotLimitError);
    const snapshot = recursiveSnapshot(directory, false, false, {}, selection);
    const maxBytes = Buffer.byteLength(snapshot);
    assert.equal(recursiveSnapshot(directory, false, false, { maxBytes }, selection), snapshot);
    assert.throws(() => recursiveSnapshot(directory, false, false, { maxBytes: maxBytes - 1 }, selection), SnapshotLimitError);
    const failed = capture('claude_rules.bundle.json', {}, ['--max-bytes', String(maxBytes - 1)]);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.include(failed.stderr, 'Snapshot bytes limit exceeded');
    write('CLAUDE.md', 'abcd');
    assert.equal(capture('claude_instructions', {}, ['--max-bytes', '3']).status, 1);
  });

  it('discovers metadata only, checks selected readability without content reads, and ignores non-Markdown readability', () => {
    write('rules/selected.md');
    write('rules/ignored.json');
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let opens = 0;
    let reads = 0;
    try {
      fs.openSync = (file: string, ...args: unknown[]) => {
        if (file === 'ignored.json') throw new Error('Excluded file must not be opened');
        if (file === 'selected.md') { opens++; throw Object.assign(new Error('synthetic access denial'), { code: 'EACCES' }); }
        return originalOpen(file, ...args);
      };
      fs.readSync = (...args: unknown[]) => { reads++; return originalRead(...args); };
      assert.equal(discover('claude_rules.bundle.json').status, 'available');
      assert.equal(opens, 0);
      assert.throws(() => reviewRecursiveFiles(path.join(root, 'rules'), false, false, {}, selection), /synthetic access denial/);
      assert.throws(() => recursiveSnapshot(path.join(root, 'rules'), false, false, {}, selection), /synthetic access denial/);
      assert.equal(opens, 2);
      assert.equal(reads, 0);
    } finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  });
});
