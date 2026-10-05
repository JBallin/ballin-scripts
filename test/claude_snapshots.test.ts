const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshotDefinitions, observeSnapshotSources, configurationSnapshotGroups } = require('../commands/backup_snapshots.ts');
const { recursiveFiles, reviewRecursiveFiles, recursiveSnapshot, fileEntry, SnapshotLimitError } = require('../commands/recursive_snapshot.ts');
import type { SnapshotDefinition, SnapshotSourceObservation } from '../commands/backup_snapshots.ts';

const selection = { markdownOnly: true, rejectHardlinks: true };
const skillSelection = { claudeSkills: true, rejectHardlinks: true };
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

  it('uses five canonical sensitive definitions and no implicit additional source', () => {
    const definitions = (snapshotDefinitions as SnapshotDefinition[]).filter(({ category }) => category === 'claude');
    assert.deepEqual(definitions.map(({ name }) => name), ['claude_instructions', 'claude_rules.bundle.json', 'claude_agents.bundle.json', 'claude_commands.bundle.json', 'claude_skills.bundle.json']);
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
      const result = capture(`claude_${directory}.bundle.json`);
      assert.equal(result.status, 0, result.stderr);
      const archive = JSON.parse(result.stdout);
      assert.equal(archive.format, 'ballin-directory');
      assert.equal(archive.version, 2);
      assert.deepEqual(archive.entries.map(({ path }: { path: string }) => path), ['.hidden.md', 'nested/a.md', 'z.md']);
      assert.deepEqual(Buffer.from(archive.entries[1].content, 'base64'), Buffer.from([0, 255, 128]));
      assert.isTrue(archive.entries[1].executable);
      assert.equal(capture(`claude_${directory}.bundle.json`).stdout, result.stdout);
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

  it('does not select settings, runtime, plugins or project configuration', () => {
    ['settings.json', '.claude.json', '.credentials.json', 'plugins/demo/rules/secret.md',
      'projects/demo/memory/MEMORY.md', 'agent-memory/demo/MEMORY.md', 'history.jsonl'].forEach((relative) => write(relative, 'DUMMY_EXCLUDED_SECRET'));
    write('.claude.json', 'DUMMY_HOME_SECRET', homeDir);
    write('project/CLAUDE.md', 'project instructions', homeDir);
    write('project/.claude/rules/project.md', 'project rules', homeDir);
    ['claude_instructions', 'claude_rules.bundle.json', 'claude_agents.bundle.json', 'claude_commands.bundle.json', 'claude_skills.bundle.json'].forEach((name) => {
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

  it('captures complete eligible skills with hidden, binary and executable support intact', () => {
    const fixtures: Record<string, string | Buffer> = {
      'demo/SKILL.md': '\ufeff---\r\n!touch /synthetic/never-execute\r\n@../../outside.md',
      'demo/.env.example': 'DUMMY_SELECTED_SECRET',
      'demo/.support/reference.txt': 'reference',
      'demo/assets/image.bin': Buffer.from([0, 255, 128]),
      'demo/scripts/run.sh': '#!/bin/sh\n',
      'demo/settings.json': '{"synthetic":"supporting example"}',
      'demo/build/fixture.key': 'ordinary authoring asset',
      'demo/empty': '',
    };
    Object.entries(fixtures).forEach(([relative, bytes]) => write(`skills/${relative}`, bytes));
    fs.chmodSync(path.join(root, 'skills/demo/scripts/run.sh'), 0o755);
    write('skills/demo/.git/config', 'DUMMY_EXCLUDED_SECRET');
    write('skills/demo/.DS_Store', 'DUMMY_EXCLUDED_SECRET');
    write('outside.md', 'DUMMY_EXTERNAL_SECRET', homeDir);
    fs.symlinkSync(homeDir, path.join(root, 'skills/demo/linked-directory'));
    fs.symlinkSync(path.join(homeDir, 'outside.md'), path.join(root, 'skills/demo/linked-file'));
    const result = capture('claude_skills.bundle.json');
    assert.equal(result.status, 0, result.stderr);
    const archive = JSON.parse(result.stdout);
    assert.equal(archive.version, 2);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), Object.keys(fixtures).sort());
    archive.entries.forEach((entry: { path: string; encoding: string; content: string | string[]; executable: boolean }) => {
      const bytes = entry.encoding === 'utf8' ? Buffer.from((entry.content as string[]).join('')) : Buffer.from(entry.content as string, 'base64');
      assert.deepEqual(bytes, Buffer.from(fixtures[entry.path]));
      assert.equal(entry.executable, entry.path === 'demo/scripts/run.sh');
    });
    assert.equal(capture('claude_skills.bundle.json').stdout, result.stdout);
    assert.notInclude(result.stdout, 'DUMMY_EXTERNAL_SECRET');
    assert.notInclude(result.stdout, 'DUMMY_EXCLUDED_SECRET');
    assert.notInclude(result.stdout, homeDir);
  });

  it('selects only immediate nonhidden skill folders with an exact regular SKILL.md', () => {
    ['synced', 'SyNcEd', 'anthropic-skills', 'ANTHROPIC-SKILLS:demo', '.trash', '.system', '.hidden'].forEach((name) => {
      write(`skills/${name}/SKILL.md`, 'DUMMY_EXCLUDED_SECRET');
    });
    write('skills/SKILL.md', 'loose root file');
    write('skills/no-marker/nested/SKILL.md');
    write('skills/lowercase/skill.md');
    write('skills/linked-marker/support.txt');
    const outside = write('outside.md', 'DUMMY_EXTERNAL_SECRET', homeDir);
    fs.symlinkSync(outside, path.join(root, 'skills/linked-marker/SKILL.md'));
    fs.mkdirSync(path.join(root, 'skills/directory-marker/SKILL.md'), { recursive: true });
    assert.equal(discover('claude_skills.bundle.json').status, 'absent');
    write('skills/valid/SKILL.md', '');
    const archive = JSON.parse(capture('claude_skills.bundle.json').stdout);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['valid/SKILL.md']);
  });

  ['directory', 'file', 'symlink'].forEach((kind) => {
    it(`excludes a whole plugin-shaped skill with a ${kind} marker`, () => {
      write('skills/plugin/SKILL.md', 'DUMMY_EXCLUDED_SECRET');
      write('skills/plugin/payload/secret.txt', 'DUMMY_EXCLUDED_SECRET');
      const marker = path.join(root, 'skills/plugin/.claude-plugin');
      if (kind === 'directory') write('skills/plugin/.claude-plugin/plugin.json');
      else if (kind === 'file') write('skills/plugin/.claude-plugin');
      else fs.symlinkSync(homeDir, marker);
      write('skills/personal/SKILL.md');
      const original = fs.lstatSync;
      try {
        fs.lstatSync = (file: string, ...args: unknown[]) => {
          if (file === 'payload' || file === '.claude-plugin') throw new Error('Excluded plugin payload must not be inspected');
          return original(file, ...args);
        };
        assert.deepEqual(recursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), ['personal/SKILL.md']);
        assert.deepEqual(reviewRecursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), ['personal/SKILL.md']);
      } finally { fs.lstatSync = original; }
      assert.notInclude(capture('claude_skills.bundle.json').stdout, 'DUMMY_EXCLUDED_SECRET');
    });

    it(`reports a legacy manifest ${kind} as unavailable without reading it`, () => {
      write('skills/personal/SKILL.md');
      const manifest = path.join(root, 'skills/manifest.json');
      if (kind === 'directory') fs.mkdirSync(manifest);
      else if (kind === 'file') write('skills/manifest.json', 'DUMMY_EXCLUDED_SECRET');
      else fs.symlinkSync(homeDir, manifest);
      const original = fs.readSync;
      try {
        fs.readSync = () => { throw new Error('Discovery must not read contents'); };
        const source = discover('claude_skills.bundle.json');
        assert.equal(source.status, 'unavailable');
        if (source.status !== 'unavailable') throw new Error('Expected unavailable legacy source');
        assert.equal(source.reason, 'unsupported-source-type');
      } finally { fs.readSync = original; }
      const result = spawnSync(process.execPath, [path.join(__dirname, '../commands/recursive_snapshot.ts'), path.join(root, 'skills'), 'claude-skills', '--reject-hardlinks'], { env: { HOME: homeDir, PATH: '' }, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.notInclude(result.stderr, 'DUMMY_');
    });
  });

  it('uses default, relocated, relative and aliased Claude skills roots', () => {
    write('skills/demo/SKILL.md', 'default');
    const active = path.join(homeDir, 'active Claude');
    write('skills/demo/SKILL.md', 'active', active);
    const alias = path.join(homeDir, 'alias'); fs.symlinkSync(active, alias);
    [active, alias, path.relative(process.cwd(), active)].forEach((CLAUDE_CONFIG_DIR) => {
      const result = capture('claude_skills.bundle.json', { CLAUDE_CONFIG_DIR });
      assert.equal(JSON.parse(result.stdout).entries[0].content.join(''), 'active');
    });
    assert.equal(JSON.parse(capture('claude_skills.bundle.json', { CLAUDE_CONFIG_DIR: '' }).stdout).entries[0].content.join(''), 'default');
    fs.rmSync(path.join(root, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(active, 'skills'), path.join(root, 'skills'));
    assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
  });

  ['SKILL.md', '.hidden-support'].forEach((leaf) => {
    it(`rejects a hard-linked selected skill ${leaf}`, () => {
      write('skills/demo/SKILL.md');
      fs.rmSync(path.join(root, 'skills/demo', leaf), { force: true });
      const outside = write('outside', 'DUMMY_EXTERNAL_SECRET', homeDir);
      fs.linkSync(outside, path.join(root, 'skills/demo', leaf));
      assert.equal(discover('claude_skills.bundle.json').status, 'discovery-failed');
      assert.throws(() => recursiveSnapshot(path.join(root, 'skills'), false, false, {}, skillSelection), /Hard-linked/);
    });
  });

  it('reviews selected skill readability without reading support or inspecting excluded trees', () => {
    write('skills/demo/SKILL.md'); write('skills/demo/.support');
    write('skills/synced/demo/SKILL.md');
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const originalOpendir = fs.opendirSync;
    let opens = 0;
    try {
      fs.readSync = () => { throw new Error('Review must not read contents'); };
      fs.opendirSync = (file: string, ...args: unknown[]) => {
        if (process.cwd().includes(`${path.sep}synced`)) throw new Error('Excluded synced tree must not be inspected');
        return originalOpendir(file, ...args);
      };
      fs.openSync = (file: string, ...args: unknown[]) => {
        opens++;
        if (file === '.support') throw Object.assign(new Error('synthetic access denial'), { code: 'EACCES' });
        return originalOpen(file, ...args);
      };
      assert.equal(discover('claude_skills.bundle.json').status, 'available'); assert.equal(opens, 0);
      assert.throws(() => reviewRecursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), /synthetic access denial/);
      assert.throws(() => recursiveSnapshot(path.join(root, 'skills'), false, false, {}, skillSelection), /synthetic access denial/);
    } finally { fs.openSync = originalOpen; fs.readSync = originalRead; fs.opendirSync = originalOpendir; }
  });

  it('counts filtered skill entries and rejects serialized-byte overflow without partial output', () => {
    write('skills/synced/demo/SKILL.md');
    const directory = path.join(root, 'skills');
    assert.throws(() => recursiveFiles(directory, false, false, { maxEntries: 0 }, skillSelection), SnapshotLimitError);
    assert.deepEqual(recursiveFiles(directory, false, false, { maxEntries: 1 }, skillSelection), []);
    write('skills/demo/SKILL.md', 'text');
    assert.throws(() => recursiveFiles(directory, false, false, { maxEntries: 2 }, skillSelection), SnapshotLimitError);
    const snapshot = recursiveSnapshot(directory, false, false, {}, skillSelection);
    const maxBytes = Buffer.byteLength(snapshot);
    assert.equal(recursiveSnapshot(directory, false, false, { maxBytes }, skillSelection), snapshot);
    const failed = capture('claude_skills.bundle.json', {}, ['--max-bytes', String(maxBytes - 1)]);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.include(failed.stderr, 'Snapshot bytes limit exceeded');
  });

  it('rechecks eligibility during collection after discovery', () => {
    write('skills/demo/SKILL.md');
    const source = discover('claude_skills.bundle.json');
    if (source.status !== 'available') throw new Error('Expected available fixture');
    write('skills/demo/.claude-plugin/plugin.json');
    const result = spawnSync(source.collector.command, source.collector.args, { env: source.collector.env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
  });
});
