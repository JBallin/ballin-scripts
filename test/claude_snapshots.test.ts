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
  const manifest = (collection: string, records: unknown[] = [{ name: 'package', source: 'plugin' }]) => (
    write(`skills/synced/${collection}/manifest.json`, JSON.stringify({ skills: records }))
  );
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

  it('selects only immediate nonhidden personal skill folders with an exact regular SKILL.md', () => {
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

  it('captures only exact plugin-origin synced packages with deterministic v2 bytes', () => {
    const collection = '1ee7e3ab-14cd-4d49-9fce-a2f5fa33d125_e29e4a19-d6c5-4efd-a06e-1dbd9ea691a8';
    const base = `synced/${collection}`;
    const fixtures: Record<string, string | Buffer> = {
      'personal/SKILL.md': 'personal',
      [`${base}/custom-review/SKILL.md`]: '---\nname: fixture\n---\n@../../outside.md',
      [`${base}/custom-review/.support/reference.txt`]: 'DUMMY_SELECTED_PRIVATE_SUPPORT',
      [`${base}/custom-review/scripts/run.sh`]: '#!/bin/sh\n',
      [`${base}/custom-review/assets/image.bin`]: Buffer.from([0, 255, 128]),
      [`${base}/pdf/SKILL.md`]: 'plugin with a default-looking name\r\n"quoted" \\ text\n',
      'synced/org-team/team-review/SKILL.md': 'organization copy',
      'synced/org-team/team-review/assets/雪.txt': 'Unicode support\n',
      'synced/org-team/anthropic-skills:fixture/SKILL.md': 'no reserved-name filter inside collections',
      'synced/.private-collection/.private-skill/SKILL.md': 'hidden validated package',
    };
    Object.entries(fixtures).reverse().forEach(([relative, bytes]) => write(`skills/${relative}`, bytes));
    fs.chmodSync(path.join(root, `skills/${base}/custom-review/scripts/run.sh`), 0o755);
    write(`skills/${base}/manifest.json`, JSON.stringify({ skills: [
      { name: 'pdf', source: 'plugin' }, { name: 'custom-review', source: 'plugin' },
      { name: 'default-edit', source: 'anthropic' }, { name: 'example', source: 'anthropic-example' },
      { name: 'future', source: 'future-default' }, { name: 'wrong-case', source: 'Plugin' },
      { name: 'missing-source' }, { name: 'wrong-type', source: { plugin: true } },
      { name: 'personal', source: 'anthropic' },
    ], privateMetadata: 'DUMMY_EXCLUDED_SECRET' }));
    manifest('org-team', [{ name: 'team-review', source: 'plugin' }, { name: 'anthropic-skills:fixture', source: 'plugin' }, { name: 'plugin-shaped', source: 'plugin' }]);
    manifest('.private-collection', [{ name: '.private-skill', source: 'plugin' }]);
    ['default-edit', 'example', 'future', 'wrong-case', 'missing-source', 'wrong-type', 'unlisted', 'personal'].forEach((name) => {
      write(`skills/${base}/${name}/SKILL.md`, 'DUMMY_EXCLUDED_SECRET');
    });
    ['manifest.json', '.last-complete-round', 'loose.txt', 'SKILL.md'].forEach((name) => write(`skills/synced/${name}`, 'DUMMY_EXCLUDED_SECRET'));
    ['.staging', '.trash'].forEach((name) => {
      write(`skills/synced/${name}/collection/package/SKILL.md`, 'DUMMY_EXCLUDED_SECRET');
      write(`skills/${base}/${name}/package/SKILL.md`, 'DUMMY_EXCLUDED_SECRET');
    });
    write(`skills/${base}/.last-complete-round`, 'DUMMY_EXCLUDED_SECRET');
    write(`skills/${base}/loose.txt`, 'DUMMY_EXCLUDED_SECRET');
    write(`skills/${base}/pdf/.git/config`, 'DUMMY_EXCLUDED_SECRET');
    write(`skills/${base}/pdf/.DS_Store`, 'DUMMY_EXCLUDED_SECRET');
    write(`skills/${base}/without-marker/nested/SKILL.md`, 'DUMMY_EXCLUDED_SECRET');
    write(`skills/${base}/wrong-case/skill.md`, 'DUMMY_EXCLUDED_SECRET');
    write('skills/synced/org-team/plugin-shaped/SKILL.md', 'DUMMY_EXCLUDED_SECRET');
    write('skills/synced/org-team/plugin-shaped/.CLAUDE-PLUGIN/plugin.json', 'DUMMY_EXCLUDED_SECRET');
    const result = capture('claude_skills.bundle.json');
    assert.equal(result.status, 0, result.stderr);
    const archive = JSON.parse(result.stdout);
    assert.equal(archive.version, 2);
    const expected: Record<string, string | Buffer> = {
      'personal/SKILL.md': fixtures['personal/SKILL.md'],
      'custom-review/SKILL.md': fixtures[`${base}/custom-review/SKILL.md`],
      'custom-review/.support/reference.txt': fixtures[`${base}/custom-review/.support/reference.txt`],
      'custom-review/scripts/run.sh': fixtures[`${base}/custom-review/scripts/run.sh`],
      'custom-review/assets/image.bin': fixtures[`${base}/custom-review/assets/image.bin`],
      'pdf/SKILL.md': fixtures[`${base}/pdf/SKILL.md`],
      'team-review/SKILL.md': fixtures['synced/org-team/team-review/SKILL.md'],
      'team-review/assets/雪.txt': fixtures['synced/org-team/team-review/assets/雪.txt'],
      'anthropic-skills:fixture/SKILL.md': fixtures['synced/org-team/anthropic-skills:fixture/SKILL.md'],
      '.private-skill/SKILL.md': fixtures['synced/.private-collection/.private-skill/SKILL.md'],
    };
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), Object.keys(expected).sort());
    archive.entries.forEach((entry: { path: string; encoding: string; content: string | string[]; executable: boolean }) => {
      const bytes = entry.encoding === 'utf8' ? Buffer.from((entry.content as string[]).join('')) : Buffer.from(entry.content as string, 'base64');
      assert.deepEqual(bytes, Buffer.from(expected[entry.path]));
      assert.equal(entry.executable, entry.path.endsWith('/scripts/run.sh'));
    });
    const metadata = JSON.parse(fs.readFileSync(path.join(root, `skills/${base}/manifest.json`), 'utf8'));
    metadata.skills.reverse(); metadata.changed = 'DUMMY_EXCLUDED_SECRET';
    write(`skills/${base}/manifest.json`, JSON.stringify(metadata));
    assert.equal(capture('claude_skills.bundle.json').stdout, result.stdout);
    fs.renameSync(path.join(root, 'skills', base), path.join(root, 'skills/synced/renamed-collection'));
    assert.equal(capture('claude_skills.bundle.json').stdout, result.stdout);
    assert.notInclude(result.stdout, 'DUMMY_EXCLUDED_SECRET');
    assert.notInclude(result.stdout, homeDir);
    const maxBytes = Buffer.byteLength(result.stdout);
    assert.equal(capture('claude_skills.bundle.json', {}, ['--max-bytes', String(maxBytes)]).stdout, result.stdout);
    const failed = capture('claude_skills.bundle.json', {}, ['--max-bytes', String(maxBytes - 1)]);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.include(failed.stderr, 'Snapshot bytes limit exceeded');
  });

  ['synced', 'personal'].forEach((collision) => {
    it(`rejects a ${collision} skill name collision before reading bodies or emitting a partial bundle`, () => {
      write('skills/synced/first/shared/SKILL.md', 'identical skill');
      write('skills/synced/first/shared/first.txt', 'first supporting file');
      const manifests = [manifest('first', [{ name: 'shared', source: 'plugin' }])];
      const prior = discover('claude_skills.bundle.json');
      if (prior.status !== 'available') throw new Error('Expected available fixture before collision');
      const second = collision === 'synced' ? 'synced/second/shared' : 'shared';
      write(`skills/${second}/SKILL.md`, 'identical skill');
      write(`skills/${second}/second.txt`, 'second supporting file');
      if (collision === 'synced') manifests.push(manifest('second', [{ name: 'shared', source: 'plugin' }]));
      const metadataInodes = new Set(manifests.map(file => fs.statSync(file).ino));
      const originalRead = fs.readSync;
      try {
        fs.readSync = (fd: number, ...args: unknown[]) => {
          if (!metadataInodes.has(fs.fstatSync(fd).ino)) throw new Error('Collision detection must not read skill bodies');
          return originalRead(fd, ...args);
        };
        assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
        assert.throws(() => reviewRecursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), 'Claude skill name collision');
      } finally { fs.readSync = originalRead; }
      const result = spawnSync(prior.collector.command, prior.collector.args, {
        encoding: 'utf8', env: prior.collector.env,
      });
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
    });
  });

  it('reads only bounded manifest metadata during discovery/review and never opens omitted payloads', () => {
    write('skills/synced/arbitrary-collection/package/SKILL.md');
    write('skills/synced/arbitrary-collection/package/.support');
    const manifestFile = manifest('arbitrary-collection', [{ name: 'package', source: 'plugin' }, { name: 'default', source: 'anthropic' }]);
    write('skills/synced/arbitrary-collection/default/SKILL.md', 'DUMMY_EXCLUDED_SECRET');
    const manifestInode = fs.statSync(manifestFile).ino;
    write('skills/synced/arbitrary-collection/.last-complete-round', 'DUMMY_EXCLUDED_SECRET');
    write('skills/synced/arbitrary-collection/.staging/package/SKILL.md', 'DUMMY_EXCLUDED_SECRET');
    const originalRead = fs.readSync;
    const originalStat = fs.lstatSync;
    const originalOpendir = fs.opendirSync;
    try {
      fs.readSync = (fd: number, ...args: unknown[]) => {
        if (fs.fstatSync(fd).ino !== manifestInode) throw new Error('Review must not read skill contents');
        return originalRead(fd, ...args);
      };
      fs.lstatSync = (file: string, ...args: unknown[]) => {
        if (['default', '.last-complete-round', '.staging'].includes(file)) throw new Error('Omitted payload must not be inspected');
        return originalStat(file, ...args);
      };
      fs.opendirSync = (file: string, ...args: unknown[]) => {
        if (process.cwd().endsWith(`${path.sep}.staging`)) throw new Error('Staging must not be traversed');
        return originalOpendir(file, ...args);
      };
      assert.equal(discover('claude_skills.bundle.json').status, 'available');
      assert.deepEqual(reviewRecursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), [
        'synced/arbitrary-collection/package/.support', 'synced/arbitrary-collection/package/SKILL.md',
      ]);
    } finally { fs.readSync = originalRead; fs.lstatSync = originalStat; fs.opendirSync = originalOpendir; }
  });

  it('omits linked sync containers, packages, markers and support without following their targets', () => {
    const outside = path.join(homeDir, 'outside');
    write('package/SKILL.md', 'DUMMY_EXTERNAL_SECRET', outside);
    write('skills/synced/collection/valid/SKILL.md');
    manifest('collection', ['valid', 'linked-package', 'linked-marker'].map(name => ({ name, source: 'plugin' })));
    fs.symlinkSync(outside, path.join(root, 'skills/synced/linked-collection'));
    fs.symlinkSync(path.join(outside, 'package'), path.join(root, 'skills/synced/collection/linked-package'));
    write('skills/synced/collection/linked-marker/.support', 'DUMMY_EXCLUDED_SECRET');
    fs.symlinkSync(path.join(outside, 'package/SKILL.md'), path.join(root, 'skills/synced/collection/linked-marker/SKILL.md'));
    fs.symlinkSync(outside, path.join(root, 'skills/synced/collection/valid/linked-support'));
    const archive = JSON.parse(capture('claude_skills.bundle.json').stdout);
    assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['valid/SKILL.md']);
    fs.rmSync(path.join(root, 'skills/synced'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'skills/synced'));
    assert.equal(discover('claude_skills.bundle.json').status, 'absent');
  });

  it('rejects selected synced hard links and counts filtered container entries before traversal', () => {
    const file = write('skills/synced/collection/package/SKILL.md');
    manifest('collection');
    fs.linkSync(file, path.join(root, 'skills/synced/collection/package/.support'));
    assert.equal(discover('claude_skills.bundle.json').status, 'discovery-failed');
    fs.rmSync(path.join(root, 'skills/synced/collection/package/.support'));
    write('skills/synced/collection/.staging/ignored/SKILL.md');
    const directory = path.join(root, 'skills');
    assert.throws(() => recursiveFiles(directory, false, false, { maxEntries: 5 }, skillSelection), SnapshotLimitError);
    assert.deepEqual(recursiveFiles(directory, false, false, { maxEntries: 6 }, skillSelection), ['synced/collection/package/SKILL.md']);
  });

  [null, {}, { skills: {} }, { skills: [null] }, { skills: [{ name: '' }] },
    ...['.', '..', '../outside', 'path/name', 'path\\name'].map(name => ({ skills: [{ name, source: 'plugin' }] })),
    { skills: [{ name: 'package', source: 'plugin' }, { name: 'package', source: 'anthropic' }] },
  ].forEach((value, index) => {
    it(`retains unavailable selection for malformed or ambiguous manifest ${index}`, () => {
      write('skills/personal/SKILL.md'); write('skills/synced/collection/package/SKILL.md');
      write('skills/synced/collection/manifest.json', JSON.stringify(value));
      assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
    });
  });

  [
    '{"skills":[{"name":"package","source":"anthropic","source":"plugin"}]}',
    '{"skills":[{"name":"package","source":"plugin","source":"anthropic"}]}',
    '{"skills":[{"name":"default","name":"package","source":"plugin"}]}',
    '{"skills":[],"skills":[{"name":"package","source":"plugin"}]}',
    '{"skills":[{"name":"package","source":"plugin"}],"skills":[]}',
    '{"skills":[{"name":"package","source":"plugin","source":"plugin"}]}',
    '{"skills":[{"name":"package","source":"anthropic","\\u0073ource":"plugin"}]}',
    '{"skills":[{"name":"default","\\u006eame":"package","source":"plugin"}]}',
    '{"skills":[],"\\u0073kills":[{"name":"package","source":"plugin"}]}',
  ].forEach((text, index) => {
    it(`makes the whole skills source unavailable for duplicate selection keys ${index}`, () => {
      write('skills/personal/SKILL.md'); write('skills/synced/collection/package/SKILL.md'); manifest('collection');
      const observation = discover('claude_skills.bundle.json');
      if (observation.status !== 'available') throw new Error('Expected available fixture');
      write('skills/synced/collection/manifest.json', text);
      assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
      assert.throws(() => reviewRecursiveFiles(path.join(root, 'skills'), false, false, {}, skillSelection), 'Claude synced skills manifest');
      const failed = spawnSync(observation.collector.command, observation.collector.args!, { env: observation.collector.env, encoding: 'utf8' });
      assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    });
  });

  it('ignores repeated non-selection metadata and delimiters in string values', () => {
    write('skills/synced/collection/package/SKILL.md');
    const description = JSON.stringify('"source":"plugin", {"skills":[]} and \\ \\u0073ource');
    write('skills/synced/collection/manifest.json', `{"source":"anthropic","source":"plugin","skills":[{
      "extra":{"skills":[],"skills":[],"name":"a","name":"b","source":"a","source":"b"},
      "description":${description},"description":"ignored","source":"\\u0070lugin","name":"package"
    }],"extra":[{"source":"anthropic","source":"plugin"}]}`);
    assert.deepEqual(JSON.parse(capture('claude_skills.bundle.json').stdout).entries.map((entry: { path: string }) => entry.path), [
      'package/SKILL.md',
    ]);
  });

  it('fails promptly for malformed escaped strings within the manifest byte budget', () => {
    write('skills/personal/SKILL.md'); write('skills/synced/collection/package/SKILL.md'); manifest('collection');
    const observation = discover('claude_skills.bundle.json');
    if (observation.status !== 'available') throw new Error('Expected available fixture');
    write('skills/synced/collection/manifest.json', '"' + 'a\\"'.repeat(250000));
    const failed = spawnSync(observation.collector.command, observation.collector.args!, {
      env: observation.collector.env, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    });
    assert.isUndefined(failed.error); assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
  });

  ['missing', 'json', 'utf8', 'directory', 'symlink', 'hardlink', 'oversized', 'records'].forEach((kind) => {
    it(`makes the whole skills source unavailable for a ${kind} manifest`, () => {
      write('skills/personal/SKILL.md'); write('skills/synced/collection/package/SKILL.md');
      const file = path.join(root, 'skills/synced/collection/manifest.json');
      if (kind === 'json') write('skills/synced/collection/manifest.json', '{DUMMY_EXCLUDED_SECRET');
      else if (kind === 'utf8') write('skills/synced/collection/manifest.json', Buffer.from([255]));
      else if (kind === 'directory') fs.mkdirSync(file);
      else if (kind === 'symlink') fs.symlinkSync(write('outside.json', 'DUMMY_EXTERNAL_SECRET', homeDir), file);
      else if (kind === 'hardlink') fs.linkSync(manifest('collection'), path.join(root, 'other-manifest'));
      else if (kind === 'oversized') write('skills/synced/collection/manifest.json', ' '.repeat(1024 * 1024 + 1));
      else if (kind === 'records') manifest('collection', Array.from({ length: 8193 }, (_, i) => ({ name: `future-${i}`, source: 'future' })));
      assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
    });
  });

  it('bounds manifest bytes and record counts across collections', () => {
    ['a', 'b'].forEach(collection => {
      write(`skills/synced/${collection}/manifest.json`, JSON.stringify({ skills: [], extra: 'x'.repeat(600000) }));
    });
    assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
    ['a', 'b'].forEach(collection => manifest(collection, Array.from({ length: 5000 }, (_, i) => ({ name: `future-${i}`, source: 'future' }))));
    assert.equal(discover('claude_skills.bundle.json').status, 'unavailable');
  });

  it('rechecks origin metadata at capture time and fails without partial output', () => {
    write('skills/personal/SKILL.md'); write('skills/synced/collection/package/SKILL.md'); manifest('collection');
    const observation = discover('claude_skills.bundle.json');
    if (observation.status !== 'available') throw new Error('Expected available fixture');
    manifest('collection', [{ name: 'package', source: 'anthropic' }]);
    const omitted = spawnSync(observation.collector.command, observation.collector.args!, { env: observation.collector.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(omitted.stdout).entries.map((e: { path: string }) => e.path), ['personal/SKILL.md']);
    write('skills/synced/collection/manifest.json', '{');
    const failed = spawnSync(observation.collector.command, observation.collector.args!, { env: observation.collector.env, encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.notInclude(failed.stderr, 'DUMMY_');
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
    write('skills/synced/.staging/demo/SKILL.md');
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const originalOpendir = fs.opendirSync;
    let opens = 0;
    try {
      fs.readSync = () => { throw new Error('Review must not read contents'); };
      fs.opendirSync = (file: string, ...args: unknown[]) => {
        if (process.cwd().endsWith(`${path.sep}.staging`)) throw new Error('Excluded staging tree must not be inspected');
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
    write('skills/anthropic-skills/demo/SKILL.md');
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
