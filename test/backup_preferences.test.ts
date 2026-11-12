const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const preferencesPath = path.join(__dirname, '..', 'commands', 'backup_preferences.ts');

describe('backup preference safety', () => {
  let root: string;
  let configPath: string;
  let guardPath: string;
  let callsPath: string;

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));
  const configFor = (kind = 'repository', enabled = false) => ({
    backup: {
      repository: kind === 'repository' ? { id: '1', ownerId: '2', name: 'fixture-backup', branch: 'main' } : null,
      includeSensitive: String(enabled),
      custom: { retained: true },
    },
    update: { backup: String(enabled), npm: 'false', custom: 'retained' },
    analytics: { enabled: String(enabled), custom: 'retained' },
    custom: { retained: true },
  });
  const run = (input = '', args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    assert.isAtMost(args.length, 1);
    return spawnSync(process.execPath, ['-e', `
    const { selectSensitiveSources, saveBackupConfig } = require(${JSON.stringify(preferencesPath)});
    const fs = require('fs');
    const file = process.env.BALLIN_TEST_CONFIG_PATH;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const selected = selectSensitiveSources(config.backup.includeSensitive === 'true');
    if (selected === undefined) process.exitCode = 1;
    else if (selected !== null) {
      config.backup.includeSensitive = String(selected);
      if (!saveBackupConfig(file, config)) process.exitCode = 1;
      console.log('Sensitive sources in backups: ' + (selected ? 'included' : 'excluded'));
    }
  `], {
    input, encoding: 'utf8',
    env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath,
      NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`, ...env }),
  }); };
  const assertNoCalls = () => assert.isFalse(fs.existsSync(callsPath), 'no child workflows or raw source reads');

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-preferences-')));
    configPath = path.join(root, 'ballin.config.json');
    callsPath = path.join(root, 'calls');
    guardPath = path.join(root, 'guard.cjs');
    fs.writeFileSync(guardPath, `
const fs = require('fs');
const cp = require('child_process');
cp.spawnSync = (...args) => { fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n'); throw new Error('No child workflows allowed'); };
const path = require('path');
const sourceFds = new Set();
const sourcePath = (file) => typeof file === 'string' && (path.resolve(file) === ${JSON.stringify(path.join(root, '.zshrc'))} || [${JSON.stringify(path.join(root, '.codex') + path.sep)}, ${JSON.stringify(path.join(root, '.agents', 'skills') + path.sep)}].some((prefix) => path.resolve(file).startsWith(prefix)));
const open = fs.openSync;
fs.openSync = (file, flags, ...args) => {
  const source = sourcePath(file);
  if (source && flags !== (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) {
    fs.appendFileSync(${JSON.stringify(callsPath)}, 'unexpected source open\\n'); throw new Error('Only metadata source opens allowed');
  }
  const fd = open(file, flags, ...args);
  if (source) sourceFds.add(fd);
  return fd;
};
const close = fs.closeSync;
fs.closeSync = (fd) => { const result = close(fd); sourceFds.delete(fd); return result; };
const descriptorRead = fs.readSync;
fs.readSync = (fd, ...args) => {
  if (sourceFds.has(fd)) {
    fs.appendFileSync(${JSON.stringify(callsPath)}, 'source descriptor read\\n'); throw new Error('No source descriptor reads allowed');
  }
  return descriptorRead(fd, ...args);
};
const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (sourceFds.has(file) || sourcePath(file)) {
    fs.appendFileSync(${JSON.stringify(callsPath)}, 'raw source read\\n'); throw new Error('No source content reads allowed');
  }
  return read(file, ...args);
};
`);
    // Availability inspection is permitted; running pipx to collect metadata is forbidden.
    fs.writeFileSync(path.join(root, 'pipx'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    writeConfig(configFor());
  });
  afterEach(() => {
    assertNoCalls();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('groups available sensitive sources above absent and unavailable sources without redundant paths', () => {
    fs.writeFileSync(path.join(root, '.zshrc'), 'fixture private content');
    const result = run('y\ny\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Sensitive source paths available now:\n  ~/.zshrc\npipx installation metadata is also available.\n');
    assert.notInclude(result.stdout, ' -> ');
    assert.notInclude(result.stdout, 'Sources not found now:');
    assert.notInclude(result.stdout, 'Unavailable now:');
    assert.notInclude(result.stdout, 'Claude');
    assert.include(result.stdout, 'Backup source details:');
    assert.notInclude(result.stdout, 'fixture private content');
  });

  [false, true].forEach((included) => {
    it(`reviews the override instruction source before the inclusion question: ${included}`, () => {
      const codex = path.join(root, '.codex'); fs.mkdirSync(codex);
      const override = path.join(codex, 'AGENTS.override.md');
      fs.writeFileSync(override, 'SYNTHETIC_OVERRIDE_CONTENT');
      const probes = path.join(root, 'override-probes');
      fs.appendFileSync(guardPath, `const definitions = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'backup_snapshots.ts'))}).snapshotDefinitions;
        const overrideDefinition = definitions.find((definition) => definition.name === 'codex_AGENTS.override.md');
        if (!overrideDefinition) throw new Error('Missing override source definition');
        const discoverOverride = overrideDefinition.discover;
        overrideDefinition.discover = (context) => {
          fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
          return discoverOverride(context);
        };\n`);
      const result = run(`${included ? 'y' : 'n'}\nn\nn\n`);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.isTrue(fs.existsSync(probes));
      assert.equal(readConfig().backup.includeSensitive, String(included));
      assert.notInclude(result.stdout, 'SYNTHETIC_OVERRIDE_CONTENT');
      assert.include(result.stdout, '~/.codex/AGENTS.override.md\n');
      assert.include(result.stdout, 'docs/backup-sources.md#what-will-ballin-back-up');
      assert.notProperty(readConfig().backup, 'sensitiveSourcesVersion');
    });
  });

  [false, true].forEach((included) => {
    it(`reviews fixed HOME user skills independently of CODEX_HOME before the inclusion question: ${included}`, () => {
      const skills = path.join(root, '.agents', 'skills');
      fs.mkdirSync(path.join(skills, 'synthetic'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'synthetic', 'SKILL.md'), 'SYNTHETIC_USER_SKILL_CONTENT');
      const active = path.join(root, '.codex', 'active'); fs.mkdirSync(active, { recursive: true });
      const probes = path.join(root, 'user-skills-probes');
      fs.appendFileSync(guardPath, `const userSkillsDefinitions = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'backup_snapshots.ts'))}).snapshotDefinitions;
        const userSkillsDefinition = userSkillsDefinitions.find((definition) => definition.name === 'codex_user_skills.bundle.json');
        if (!userSkillsDefinition) throw new Error('Missing user skills source definition');
        const discoverUserSkills = userSkillsDefinition.discover;
        userSkillsDefinition.discover = (context) => {
          fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
          return discoverUserSkills(context);
        };\n`);
      const result = run(`${included ? 'y' : 'n'}\nn\nn\n`, ['setup'], { CODEX_HOME: active });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.isTrue(fs.existsSync(probes));
      assert.equal(readConfig().backup.includeSensitive, String(included));
      assert.notInclude(result.stdout, 'SYNTHETIC_USER_SKILL_CONTENT');
      {
        assert.include(result.stdout, '~/.agents/skills\n');
        assert.notInclude(result.stdout, 'Sources not found now:');
        assert.notInclude(result.stdout, 'codex_skills.bundle.json');
      }
    });
  });

  it('discloses current and future sensitive sources before acceptance without adding consent state', () => {
    const initial = configFor('repository', false);
    writeConfig(initial);
    const result = run('n\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    const disclosure = 'Backup source details:';
    assert.isAtLeast(result.stdout.indexOf(disclosure), 0);
    assert.isBelow(result.stdout.indexOf(disclosure), result.stdout.indexOf('Include sensitive sources in future backups?'));
    assert.isBelow(result.stdout.indexOf('even without sensitive sources.'), result.stdout.indexOf('Include sensitive sources in future backups?'));
    const consent = result.stdout.slice(result.stdout.indexOf('Backup source details:'), result.stdout.indexOf('Include sensitive sources in future backups?'));
    assert.include(result.stdout.replace(/\s+/gu, ' '), 'Inventories and filtered preferences can contain private information or secrets even without sensitive sources.');
    assert.include(consent, 'Backup source details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md#what-will-ballin-back-up\n');
    assert.deepEqual(consent.match(/https:\/\/[^\s]+/gu), ['https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md#what-will-ballin-back-up']);
    assert.notInclude(result.stdout, 'Excluding sources does not remove');
    assert.deepEqual(Object.keys(readConfig().backup).sort(), Object.keys(initial.backup).sort());
    assert.equal(readConfig().backup.includeSensitive, 'false');
  });

  it('stops on sensitive inspection failure without saving', () => {
    fs.writeFileSync(path.join(root, '.zshrc'), 'fixture content');
    fs.appendFileSync(guardPath, `const realpath = fs.realpathSync; fs.realpathSync = (file, ...args) => {
      if (file === ${JSON.stringify(path.join(root, '.zshrc'))}) throw new Error('fixture resolution failure');
      return realpath(file, ...args);
    };\n`);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\ny\ny\ny\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to review');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.notInclude(result.stdout, 'Automatically run');
  });

  it('allows exclusion after source review fails without saving inclusion', () => {
    fs.writeFileSync(path.join(root, '.zshrc'), 'fixture content');
    fs.appendFileSync(guardPath, `const realpath = fs.realpathSync; fs.realpathSync = (file, ...args) => {
      if (file === ${JSON.stringify(path.join(root, '.zshrc'))}) throw new Error('fixture resolution failure');
      return realpath(file, ...args);
    };\n`);
    writeConfig(configFor('repository', true));
    const result = run('n\n\n\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Unable to review'); assert.include(result.stdout, 'Sensitive sources in backups: excluded');
    assert.equal(readConfig().backup.includeSensitive, 'false');
  });

  const denyReadAccess = (file: string): string => {
    const attempts = path.join(root, 'access-attempts');
    fs.appendFileSync(guardPath, `const metadataOpen = fs.openSync; fs.openSync = (entry, ...args) => {
      if (typeof entry === 'string' && path.resolve(entry) === ${JSON.stringify(file)}) {
        fs.appendFileSync(${JSON.stringify(attempts)}, 'denied\\n');
        const error = new Error('synthetic unreadable leaf'); error.code = 'EACCES'; throw error;
      }
      return metadataOpen(entry, ...args);
    };\n`);
    return attempts;
  };

  ['skills', 'rules', 'agents'].forEach((tree) => {
    it(`refuses opt-in when a selected recursive ${tree} leaf is unreadable`, () => {
      const leaf = path.join(root, '.codex', tree, 'synthetic', 'instructions.md');
      fs.mkdirSync(path.dirname(leaf), { recursive: true });
      fs.writeFileSync(leaf, 'SYNTHETIC_PRIVATE_CONTENT');
      const attempts = denyReadAccess(leaf);
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run('y\ny\ny\ny\n');
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stdout, `Unable to review codex_${tree}.bundle.json`);
      assert.isTrue(fs.existsSync(attempts), 'selected leaf must receive a metadata access check');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.notInclude(result.stdout, 'Automatically run');
      assert.notInclude(result.stdout, 'SYNTHETIC_PRIVATE_CONTENT');
    });
  });

  [false, true].forEach((selected) => {
    it(`checks read access only for selected named TOML profiles: selected ${selected}`, () => {
      const codex = path.join(root, '.codex'); fs.mkdirSync(codex);
      fs.writeFileSync(path.join(codex, 'synthetic.config.toml'), 'synthetic profile');
      const denied = path.join(codex, selected ? 'synthetic.config.toml' : 'history.jsonl');
      if (!selected) fs.writeFileSync(denied, 'synthetic runtime');
      const attempts = denyReadAccess(denied);
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run('y\ny\nn\nn\n');
      assert.equal(result.status, selected ? 1 : 0, result.stdout + result.stderr);
      assert.equal(fs.existsSync(attempts), selected);
      if (selected) {
        assert.include(result.stdout, 'Unable to review codex_profiles.bundle.json');
        assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      } else assert.equal(readConfig().backup.includeSensitive, 'true');
    });
  });

  it('aborts opt-in after fatal snapshot working-directory restoration without later discovery', () => {
    const codex = path.join(root, '.codex');
    fs.mkdirSync(path.join(codex, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'agents', 'synthetic.md'), 'synthetic agent');
    fs.writeFileSync(path.join(codex, 'config.toml'), 'synthetic later source');
    const restored = path.join(root, 'restore-attempt');
    const later = path.join(root, 'later-discovery');
    fs.appendFileSync(guardPath, `const originalCwd = process.cwd(); const chdir = process.chdir;
      process.chdir = (directory) => {
        if (directory === originalCwd) {
          fs.writeFileSync(${JSON.stringify(restored)}, 'failed'); throw new Error('synthetic restore failure');
        }
        return chdir(directory);
      };
      const lstat = fs.lstatSync;
      fs.lstatSync = (entry, ...args) => {
        if (typeof entry === 'string' && path.resolve(entry) === ${JSON.stringify(path.join(codex, 'config.toml'))}) fs.writeFileSync(${JSON.stringify(later)}, 'continued');
        return lstat(entry, ...args);
      };\n`);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\ny\ny\ny\n');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.isTrue(fs.existsSync(restored));
    assert.isFalse(fs.existsSync(later), 'fatal restoration must stop later source discovery');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.notInclude(result.stdout, 'Automatically run');
  });

  it('displays configured Codex aliases and canonical paths for raw and recursive sources', () => {
    const codex = path.join(root, '.codex');
    fs.mkdirSync(path.join(codex, 'skills', 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'config.toml'), 'synthetic config');
    fs.writeFileSync(path.join(codex, 'skills', 'synthetic', 'SKILL.md'), 'synthetic skill');
    const alias = path.join(root, 'codex-alias'); fs.symlinkSync(codex, alias);
    const result = run('y\ny\nn\nn\n', ['setup'], { CODEX_HOME: alias });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '~/.codex/config.toml');
    assert.include(result.stdout, '~/.codex/skills');
    assert.equal(readConfig().backup.includeSensitive, 'true');
  });

  it('reviews Codex source metadata without following absolute descendant paths', () => {
    const codex = path.join(root, '.codex');
    fs.mkdirSync(path.join(codex, 'skills', 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'config.toml'), 'synthetic config');
    fs.writeFileSync(path.join(codex, 'skills', 'synthetic', 'SKILL.md'), 'synthetic skill');
    const alias = path.join(root, 'metadata-alias'); fs.symlinkSync(codex, alias);
    fs.appendFileSync(guardPath, `const selectedDescendant = (entry) => typeof entry === 'string' && path.isAbsolute(entry)
      && [${JSON.stringify(codex + path.sep)}, ${JSON.stringify(alias + path.sep)}].some((prefix) => entry.startsWith(prefix));
      for (const method of ['realpathSync', 'statSync', 'accessSync']) {
        const original = fs[method];
        fs[method] = (entry, ...args) => {
          if (selectedDescendant(entry)) {
            fs.appendFileSync(${JSON.stringify(callsPath)}, method + ' followed absolute source\\n');
            throw new Error('Synthetic forbidden absolute source lookup');
          }
          return original(entry, ...args);
        };
      }\n`);
    const result = run('y\ny\nn\nn\n', ['setup'], { CODEX_HOME: alias });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '~/.codex/config.toml');
    assert.include(result.stdout, '~/.codex/skills');
    assert.equal(readConfig().backup.includeSensitive, 'true');
  });

  it('shows distinct resolved files and directories outside HOME without shortening their prefix', () => {
    const outside = fs.mkdtempSync(`${root}-outside-`);
    try {
      const actual = fs.realpathSync(outside);
      fs.mkdirSync(path.join(outside, 'skills', 'one'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'config.toml'), 'fixture');
      fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'fixture');
      fs.writeFileSync(path.join(outside, 'skills', 'one', 'SKILL.md'), 'fixture');
      fs.writeFileSync(path.join(root, '.zshrc'), 'fixture');
      const result = run('y\nn\nn\n', ['setup'], { CODEX_HOME: outside });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const suffix of ['config.toml', 'AGENTS.md', 'skills']) {
        assert.include(result.stdout, `  ${path.join(actual, suffix)}\n`);
      }
      assert.include(result.stdout, '  ~/.zshrc\n');
      assert.notInclude(result.stdout, 'codex_config.toml:');
      assert.notInclude(result.stdout, `~${actual.slice(root.length)}`);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('shows printable paths with spaces, quotes, and backslashes without added delimiters', () => {
    const outside = fs.mkdtempSync(`${root}-space \"quote\" \\slash-`);
    try {
      fs.writeFileSync(path.join(outside, 'config.toml'), 'fixture');
      const result = run('n\nn\nn\n', ['setup'], { CODEX_HOME: outside });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, `  ${path.join(fs.realpathSync(outside), 'config.toml')}\n`);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('escapes terminal controls and line separators in resolved paths', () => {
    const outside = fs.mkdtempSync(`${root}-line\nreturn\r${String.fromCharCode(27)}[31m\u0085\u202e\u2028-`);
    try {
      fs.writeFileSync(path.join(outside, 'config.toml'), 'fixture');
      const result = run('n\nn\nn\n', ['setup'], { CODEX_HOME: outside });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const actual = path.join(fs.realpathSync(outside), 'config.toml');
      const expected = JSON.stringify(actual).replace(/\u0085/gu, '\\u0085').replace(/\u202e/gu, '\\u202e').replace(/\u2028/gu, '\\u2028');
      assert.include(result.stdout, `  ${expected}\n`);
      for (const unsafe of ['\r', String.fromCharCode(27), '\u0085', '\u202e', '\u2028']) assert.notInclude(result.stdout, unsafe);
      assert.notInclude(result.stdout, actual);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('reviews recursive Codex directories with metadata without collecting their contents', () => {
    const skills = path.join(root, '.codex', 'skills');
    fs.mkdirSync(path.join(skills, 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'synthetic', 'SKILL.md'), 'SYNTHETIC_PRIVATE_CONTENT');
    const result = run('y\ny\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, '~/.codex/skills');
    assert.notInclude(result.stdout, 'codex_skills.bundle.json:');
    assert.notInclude(result.stdout, 'SYNTHETIC_PRIVATE_CONTENT');
  });

});
