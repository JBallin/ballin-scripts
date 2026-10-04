const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
const preferencesPath = path.join(__dirname, '..', 'commands', 'backup_preferences.ts');

describe('guided preference setup', () => {
  let root: string;
  let configPath: string;
  let guardPath: string;
  let callsPath: string;
  let capture: ReturnType<typeof createAnalyticsCapture>;

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));
  const configFor = (kind = 'repository', enabled = false) => ({
    backup: {
      id: kind === 'legacy-gist' ? 'fixture-gist' : null,
      repository: kind === 'repository' ? { id: '1', ownerId: '2', name: 'fixture-backup', branch: 'main' } : null,
      includeSensitive: String(enabled),
      custom: { retained: true },
    },
    update: { backup: String(enabled), npm: 'false', custom: 'retained' },
    analytics: { enabled: String(enabled), custom: 'retained' },
    custom: { retained: true },
  });
  const run = (input = '', args = ['setup'], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [ballinPath, ...args], {
    input,
    encoding: 'utf8',
    env: testChildEnvironment({
      HOME: root,
      PATH: root,
      BALLIN_TEST_CONFIG_PATH: configPath,
      NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`,
      ...env,
    }),
  });
  const assertNoCalls = () => assert.isFalse(fs.existsSync(callsPath), 'no child workflows or raw source reads');

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-preferences-')));
    configPath = path.join(root, 'ballin.config.json');
    callsPath = path.join(root, 'calls');
    guardPath = path.join(root, 'guard.cjs');
    capture = createAnalyticsCapture(root);
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
    assert.include(result.stdout, `Sensitive sources available now:\n  pipx: installation metadata\n  zshrc.sh: ${JSON.stringify(path.join(root, '.zshrc'))}\n`);
    assert.notInclude(result.stdout, ' -> ');
    assert.include(result.stdout, 'Not found now: bash_profile.sh, bashrc.sh, claude_agents.bundle.json, claude_commands.bundle.json, claude_instructions, claude_rules.bundle.json, codex_agents.bundle.json, codex_AGENTS.md, codex_AGENTS.override.md, codex_config.toml, codex_hooks.json, codex_marketplace.json, codex_profiles.bundle.json, codex_rules.bundle.json, codex_skills.bundle.json, codex_user_skills.bundle.json, gitconfig, gitignore_global, nanorc, nvmrc, profile.sh, vimrc, zprofile.sh\n');
    assert.include(result.stdout, 'Unavailable now: vs_keybindings, vs_settings, vsI_keybindings, vsI_settings\n');
    assert.include(result.stdout, 'pipx installation metadata may contain original URLs, credentials, and backend arguments.');
    assert.notInclude(result.stdout, 'fixture private content');
  });

  [false, true].forEach((included) => {
    it(`reviews the override instruction source only after sensitive opt-in: ${included}`, () => {
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
      const result = run(`${included ? 'y' : 'n'}\ny\nn\nn\n`);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.existsSync(probes), included);
      assert.equal(readConfig().backup.includeSensitive, String(included));
      assert.notInclude(result.stdout, 'SYNTHETIC_OVERRIDE_CONTENT');
      if (included) assert.include(result.stdout, `codex_AGENTS.override.md: ${JSON.stringify(override)}\n`);
      else assert.notInclude(result.stdout, 'codex_AGENTS.override.md:');
      assert.include(result.stdout, 'Opting in covers all currently supported sensitive sources and future additions to this maintained catalog.');
      assert.notProperty(readConfig().backup, 'sensitiveSourcesVersion');
    });
  });

  [false, true].forEach((included) => {
    it(`reviews fixed HOME user skills independently of CODEX_HOME only after opt-in: ${included}`, () => {
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
      const result = run(`${included ? 'y' : 'n'}\ny\nn\nn\n`, ['setup'], { CODEX_HOME: active });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.existsSync(probes), included);
      assert.equal(readConfig().backup.includeSensitive, String(included));
      assert.notInclude(result.stdout, 'SYNTHETIC_USER_SKILL_CONTENT');
      if (included) {
        assert.include(result.stdout, `codex_user_skills.bundle.json: ${JSON.stringify(skills)}\n`);
        assert.include(result.stdout, 'Not found now:');
        assert.include(result.stdout, 'codex_skills.bundle.json,');
      } else assert.notInclude(result.stdout, 'codex_user_skills.bundle.json:');
    });
  });

  [false, true].forEach((enabled) => {
    it(`accepts current ${enabled} defaults and preserves custom settings`, () => {
      const initial = configFor('repository', enabled);
      writeConfig(initial);
      fs.writeFileSync(path.join(root, '.zshrc'), 'fixture private content');
      const result = run('\ny\n\n\n');
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, `Also include sensitive sources? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.include(result.stdout, `\`ballin update\`? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.include(result.stdout, `Usage analytics are currently ${enabled ? 'enabled' : 'disabled'}.`);
      assert.include(result.stdout, `Share usage analytics to help improve Ballin? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.deepEqual(readConfig(), initial);
      assert.include(result.stdout, 'preference review complete');
      if (enabled) {
        assert.include(result.stdout, 'pipx: installation metadata');
        assert.include(result.stdout, JSON.stringify(path.join(root, '.zshrc')));
      } else assert.notInclude(result.stdout, 'pipx:');
    });
    it(`changes all ${enabled} choices through the existing owners`, () => {
      writeConfig(configFor('repository', enabled));
      const answer = enabled ? 'n' : 'y';
      const result = run(`${answer}\ny\n${answer}\n${answer}\n`);
      assert.equal(result.status, 0, result.stderr);
      const config = readConfig();
      assert.equal(config.backup.includeSensitive, String(!enabled));
      assert.equal(config.update.backup, String(!enabled));
      assert.equal(config.analytics.enabled, String(!enabled));
      assert.include(result.stdout, `"backup.includeSensitive" set to: "${!enabled}"`);
    });
  });

  it('reviews only analytics when unconfigured', () => {
    const initial = configFor('unconfigured');
    writeConfig(initial);
    const result = run('y\n');
    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, 'Also include sensitive sources');
    assert.notInclude(result.stdout, 'Automatically run');
    assert.include(result.stdout, 'Run `ballin backup setup`');
    assert.equal(readConfig().backup.includeSensitive, initial.backup.includeSensitive);
    assert.equal(readConfig().update.backup, 'false');
    assert.equal(readConfig().analytics.enabled, 'true');
  });

  it('rejects stale Gist linkage before review and preserves local choices', () => {
    writeConfig(configFor('legacy-gist', true));
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\ny\ny\ny\n');
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Gist backup support has been retired');
    assert.include(result.stderr, '`ballin backup disconnect`');
    assert.include(result.stderr, '`ballin backup setup`');
    assert.notInclude(result.stdout, 'Review your Ballin');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });

  ['', 'y', 'y\n', 'y\ny', 'y\nn\n'].forEach((input) => {
    it(`leaves unconfirmed sensitive choice unchanged on ${JSON.stringify(input)}`, () => {
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Preference review cancelled');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.notInclude(result.stdout, 'Automatically run');
      assert.notInclude(result.stdout, 'Share usage analytics to help improve Ballin?');
    });
  });

  ['n\ny\n', 'n\ny\nn', 'n\ny\nn\n', 'n\ny\nn\nn'].forEach((input) => {
    it(`stops at EOF and retains only confirmed choices: ${JSON.stringify(input)}`, () => {
      writeConfig(configFor('repository', true));
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      const config = readConfig();
      assert.equal(config.backup.includeSensitive, 'false');
      assert.equal(config.update.backup, input.startsWith('n\ny\nn\n') ? 'false' : 'true');
      assert.equal(config.analytics.enabled, 'true');
      assert.include(result.stdout, 'Earlier confirmed choices remain saved');
      if (!input.startsWith('n\ny\nn\n')) assert.notInclude(result.stdout, 'Share usage analytics to help improve Ballin?');
    });
  });

  ['\n', 'n\n', 'y\n', 'Y\n', '', 'y'].forEach((input) => {
    it(`uses the fresh automatic-backup default without running a backup: ${JSON.stringify(input)}`, () => {
      writeConfig(configFor('repository', true));
      const result = spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(preferencesPath)}).offerAutomaticUpdateBackup(process.env.BALLIN_TEST_CONFIG_PATH) ? 0 : 1`], {
        input, encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath, NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}` }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Automatically run `ballin backup` as part of `ballin update`? [y/N]');
      assert.equal(readConfig().update.backup, ['y\n', 'Y\n', 'y'].includes(input) ? 'true' : 'false');
    });
  });

  it('preserves the pending automatic choice on EOF while onboarding still saves false', () => {
    writeConfig(configFor('repository', true));
    assert.equal(run().status, 0);
    assert.equal(readConfig().update.backup, 'true');
    const result = spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(preferencesPath)}).offerAutomaticUpdateBackup(process.env.BALLIN_TEST_CONFIG_PATH) ? 0 : 1`], {
      input: '', encoding: 'utf8', env: testChildEnvironment({ HOME: root, BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfig().update.backup, 'false');
  });

  ['sensitive', 'automatic'].forEach((choice) => {
    it(`preserves the pending ${choice} choice on SIGINT`, async () => {
      writeConfig(configFor('repository', true));
      const child = spawn(process.execPath, [ballinPath, 'setup'], {
        env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath, NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}` }),
      });
      let output = '';
      let signalled = false;
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const prompt = choice === 'sensitive' ? 'Also include sensitive sources' : 'Automatically run';
        if (!signalled && output.includes(prompt)) { signalled = true; child.kill('SIGINT'); }
      });
      if (choice === 'automatic') child.stdin.write('n\ny\n');
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture prompt timeout')); }, 3000);
        child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code: number | null, signal: string | null) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.equal(result.signal, 'SIGINT');
      assert.equal(readConfig().backup.includeSensitive, choice === 'sensitive' ? 'true' : 'false');
      assert.equal(readConfig().update.backup, 'true');
      assert.equal(readConfig().analytics.enabled, 'true');
    });
  });

  it('accepts native boolean choices', () => {
    const config = configFor('repository');
    writeConfig({ ...config, backup: { ...config.backup, includeSensitive: true }, update: { backup: false }, analytics: { enabled: true } });
    const result = run('\ny\n\n\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfig().backup.includeSensitive, 'true');
    assert.equal(readConfig().update.backup, 'false');
    assert.equal(readConfig().analytics.enabled, 'true');
  });

  it('discloses current and future sensitive sources before acceptance without adding consent state', () => {
    const initial = configFor('repository', false);
    writeConfig(initial);
    const result = run('n\ny\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    const disclosure = 'Opting in covers all currently supported sensitive sources and future additions to this maintained catalog.';
    assert.isAtLeast(result.stdout.indexOf(disclosure), 0);
    assert.isBelow(result.stdout.indexOf(disclosure), result.stdout.indexOf('Also include sensitive sources'));
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
    assert.include(result.stdout, `codex_config.toml: ${JSON.stringify(path.join(alias, 'config.toml'))} -> ${JSON.stringify(path.join(codex, 'config.toml'))}`);
    assert.include(result.stdout, `codex_skills.bundle.json: ${JSON.stringify(path.join(alias, 'skills'))} -> ${JSON.stringify(path.join(codex, 'skills'))}`);
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
    assert.include(result.stdout, `codex_config.toml: ${JSON.stringify(path.join(alias, 'config.toml'))} -> ${JSON.stringify(path.join(codex, 'config.toml'))}`);
    assert.include(result.stdout, `codex_skills.bundle.json: ${JSON.stringify(path.join(alias, 'skills'))} -> ${JSON.stringify(path.join(codex, 'skills'))}`);
    assert.equal(readConfig().backup.includeSensitive, 'true');
  });

  it('reviews recursive Codex directories with metadata without collecting their contents', () => {
    const skills = path.join(root, '.codex', 'skills');
    fs.mkdirSync(path.join(skills, 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'synthetic', 'SKILL.md'), 'SYNTHETIC_PRIVATE_CONTENT');
    const result = run('y\ny\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'codex_skills.bundle.json:');
    assert.include(result.stdout, JSON.stringify(skills));
    assert.notInclude(result.stdout, 'SYNTHETIC_PRIVATE_CONTENT');
  });

  it('preserves the existing sensitive choice when final confirmation is cancelled', () => {
    const initial = configFor('repository', true);
    writeConfig(initial);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });

  it('reports prompt input failure without changing pending choices', () => {
    fs.appendFileSync(guardPath, `const readSync = fs.readSync; fs.readSync = (fd, ...args) => {
      if (fd === 0) throw new Error('fixture input failure');
      return readSync(fd, ...args);
    };\n`);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run();
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Unable to complete preference review');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });

  it('requires HOME only for opted-in sensitive review', () => {
    const result = run('y\n', ['setup'], { HOME: undefined });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'HOME is required');
  });

  ['sensitive', 'automatic'].forEach((choice) => {
    it(`stops on ${choice} preference persistence failure`, () => {
      const result = choice === 'automatic'
        ? spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(preferencesPath)}).reviewAutomaticUpdateBackup(process.env.BALLIN_TEST_CONFIG_PATH, { defaultEnabled: false, cancelOnEof: true }) === 'failed' ? 1 : 0`], {
          input: 'y\n', encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath, NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`, BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1' }),
        })
        : run('y\ny\n', ['setup'], { BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1' });
      assert.equal(result.status, 1);
      if (choice === 'automatic') assert.include(result.stdout, 'Unable to save the automatic-backup preference');
      assert.equal(readConfig().backup.includeSensitive, 'false');
      assert.equal(readConfig().update.backup, 'false');
    });
  });

  it('reports analytics persistence failure and preserves its choice', () => {
    writeConfig(configFor('unconfigured'));
    fs.appendFileSync(guardPath, `fs.renameSync = () => { throw new Error('fixture write failure'); };\n`);
    const result = run('y\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to save the analytics preference');
    assert.equal(readConfig().analytics.enabled, 'false');
  });

  const invalids: [string, (config: ReturnType<typeof configFor>) => unknown][] = [
    ['JSON', () => '{'],
    ['root', () => []],
    ['section', (config) => ({ ...config, update: [] })],
    ['destination', (config) => ({ ...config, backup: { repository: { id: '1' } } })],
    ['sensitive', (config) => ({ ...config, backup: { ...config.backup, includeSensitive: 'invalid' } })],
    ['automatic', (config) => ({ ...config, update: { backup: 'invalid' } })],
    ['analytics', (config) => ({ ...config, analytics: { enabled: 'invalid' } })],
    ['missing analytics', (config) => ({ ...config, analytics: {} })],
  ];
  invalids.forEach(([name, invalid]) => {
    it(`rejects invalid ${name} before any prompt or repair`, () => {
      const value = invalid(configFor());
      if (name === 'JSON') fs.writeFileSync(configPath, value); else writeConfig(value);
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run('y\ny\ny\ny\n');
      assert.equal(result.status, 1);
      const key = ({ sensitive: 'backup.includeSensitive', automatic: 'update.backup', analytics: 'analytics.enabled', 'missing analytics': 'analytics.enabled' } as Record<string, string>)[name];
      if (key) assert.equal(result.stderr, `ballin setup: Invalid \`${key}\`; expected true or false.\nRepair the local configuration before retrying. Use \`ballin config get\` to inspect it or \`ballin config reset\` to restore defaults.\n`);
      assert.include(result.stderr, 'Repair the local configuration');
      assert.notInclude(result.stdout, 'Review your Ballin');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    });
  });
  it('does not create missing config', () => {
    fs.rmSync(configPath);
    const result = run('y\n');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'ballin setup: Local config is missing.\nRepair the local configuration before retrying. Use `ballin config get` to inspect it or `ballin config reset` to restore defaults.\n');
    assert.isFalse(fs.existsSync(configPath));
  });

  ['missing', 'malformed', 'enabled'].forEach((state) => {
    it(`provides offline setup help with ${state} config`, () => {
      if (state === 'missing') fs.rmSync(configPath);
      else if (state === 'malformed') fs.writeFileSync(configPath, '{');
      else writeConfig(configFor('repository', true));
      fs.appendFileSync(guardPath, `const originalRead = fs.readFileSync; fs.readFileSync = (file, ...args) => {
        if (file === ${JSON.stringify(configPath)}) throw new Error('Help must not read config');
        return originalRead(file, ...args);
      };\n`);
      const result = run('', ['setup', '--help'], {
        ...capture.env,
        NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'ballin setup --help');
      assert.notInclude(result.stdout, 'Review your Ballin');
      assert.deepEqual(capture.readEvents(), []);
    });
  });
  it('rejects unsupported setup arguments without running preference prompts', () => {
    const result = run('y\n', ['setup', 'extra']);
    assert.equal(result.status, 2);
    assert.include(result.stderr, 'Usage: ballin setup');
    assert.notInclude(result.stdout, 'Review your Ballin');
  });
  it('uses the existing identity owner when guided review enables analytics', () => {
    writeConfig(configFor('unconfigured'));
    fs.rmSync(capture.installIdPath);
    const result = run('y\n', ['setup'], {
      ...capture.env,
      NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(capture.installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
    assert.deepEqual(capture.readEvents().map((event: { command: string }) => event.command), ['ballin setup']);
  });

  it('uses only the existing top-level analytics event', () => {
    writeConfig(configFor('unconfigured', true));
    const result = run('\n', ['setup'], {
      ...capture.env,
      NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(capture.readEvents().map((event: { command: string; schemaVersion: number }) => [event.command, event.schemaVersion]), [['ballin setup', 1]]);
  });
});
