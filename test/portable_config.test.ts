const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const {
  PortableConfigError,
  projectPortablePreferences,
  readSetupConfigContext,
  resolveBackupInclusion,
  restorePortablePreferences,
} = require('../config/portable.ts');
import type { ConfigObject } from '../config/portable.ts';

const updateKeys = ['cleanup', 'selfUpdate', 'backup', 'softwareupdate', 'npm', 'nvm'];
const inclusionKeys = ['includeRaw', 'includeDetailed'];
const booleanCases = [
  { input: true, canonical: 'true' },
  { input: false, canonical: 'false' },
  { input: 'true', canonical: 'true' },
  { input: 'false', canonical: 'false' },
];
const invalidValues = [null, 0, 1, '', 'TRUE', 'false ', [], {}, 'dummy-sensitive-value'];
const baseline = (): ConfigObject => ({
  update: {
    cleanup: 'true', selfUpdate: 'true', backup: 'false', softwareupdate: 'true', npm: 'false', nvm: 'false',
  },
  backup: { id: null, host: 'local.example.test', includeRaw: 'false', includeDetailed: 'false' },
  analytics: { enabled: 'true' },
});

describe('portable Ballin preferences', () => {
  describe('setup context before defaults are filled', () => {
    let temporaryRoot: string;
    let configPath: string;

    beforeEach(() => {
      temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-portable-context-'));
      configPath = path.join(temporaryRoot, 'config.json');
    });

    afterEach(() => {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    it('distinguishes a missing file from every present local leaf without writing defaults', () => {
      assert.deepEqual(readSetupConfigContext(configPath), {});
      assert.isFalse(fs.existsSync(configPath));
      const original = {
        update: { npm: false, backup: null, cleanup: { invalid: 'private-value' } },
        analytics: { enabled: true },
        backup: { includeRaw: 'invalid', custom: [1, 2] },
        custom: { token: 'dummy-sensitive-value' },
      };
      const text = JSON.stringify(original);
      fs.writeFileSync(configPath, text);
      assert.deepEqual(readSetupConfigContext(configPath), original);
      assert.equal(fs.readFileSync(configPath, 'utf8'), text);
    });

    it('allows missing sections and rejects malformed JSON without exposing its content', () => {
      fs.writeFileSync(configPath, '{}');
      assert.deepEqual(readSetupConfigContext(configPath), {});
      fs.writeFileSync(configPath, '{dummy-sensitive-value');
      assert.throws(() => readSetupConfigContext(configPath), PortableConfigError, 'Config is not valid JSON.');
      assert.equal(fs.readFileSync(configPath, 'utf8'), '{dummy-sensitive-value');
    });

    [null, [], true, 'dummy-sensitive-value'].forEach((value) => {
      it(`rejects a non-object root ${JSON.stringify(value)}`, () => {
        fs.writeFileSync(configPath, JSON.stringify(value));
        assert.throws(() => readSetupConfigContext(configPath), PortableConfigError, 'Invalid config; expected a JSON object.');
      });
      ['update', 'backup', 'analytics'].forEach((section) => {
        it(`rejects a malformed ${section} ancestor ${JSON.stringify(value)} before refresh`, () => {
          const contents = JSON.stringify({ [section]: value });
          fs.writeFileSync(configPath, contents);
          assert.throws(() => readSetupConfigContext(configPath), PortableConfigError, `Invalid ${section}; expected a JSON object.`);
          assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
        });
      });
    });

    it('reports inaccessible config without disclosing its path', () => {
      assert.throws(() => readSetupConfigContext(temporaryRoot), PortableConfigError, 'Unable to read config.');
    });
  });

  describe('explicit export permissions', () => {
    updateKeys.forEach((key) => {
      booleanCases.forEach(({ input, canonical }) => {
        it(`exports update.${key}=${JSON.stringify(input)} as a canonical string`, () => {
          assert.deepEqual(projectPortablePreferences({ update: { [key]: input } }), { update: { [key]: canonical } });
        });
      });
      invalidValues.forEach((value) => {
        it(`rejects invalid update.${key}=${JSON.stringify(value)} without exposing its value`, () => {
          assert.throws(
            () => projectPortablePreferences({ update: { [key]: value } }),
            PortableConfigError,
            `Invalid update.${key}; expected true or false.`,
          );
        });
      });
    });

    inclusionKeys.forEach((key) => {
      booleanCases.forEach(({ input, canonical }) => {
        it(`exports backup.${key}=${JSON.stringify(input)} as a canonical string`, () => {
          assert.deepEqual(projectPortablePreferences({ backup: { [key]: input } }), { backup: { [key]: canonical } });
        });
      });
      invalidValues.forEach((value) => {
        it(`rejects invalid backup.${key}=${JSON.stringify(value)}`, () => {
          assert.throws(
            () => projectPortablePreferences({ backup: { [key]: value } }),
            PortableConfigError,
            `Invalid backup.${key}; expected true or false.`,
          );
        });
      });
    });

    it('exports analytics opt-out only for exact string false', () => {
      assert.deepEqual(projectPortablePreferences({ analytics: { enabled: 'false' } }), { analytics: { enabled: 'false' } });
      [true, false, 'true', undefined, ...invalidValues].forEach((enabled) => {
        assert.deepEqual(projectPortablePreferences({ analytics: { enabled } }), {});
      });
      [false, null, [], 'false'].forEach((analytics) => {
        assert.deepEqual(projectPortablePreferences({ analytics }), {});
      });
    });

    it('omits missing, destination, identity, unknown and future fields without changing local data', () => {
      const local = {
        update: { futureIntegration: true },
        backup: { id: 'private-id', host: 'private.example.test', includeFuture: true },
        analytics: { enabled: 'true', installId: 'private-identity' },
        custom: { token: 'dummy-sensitive-value' },
      };
      const before = structuredClone(local);
      assert.deepEqual(projectPortablePreferences({}), {});
      assert.deepEqual(projectPortablePreferences(local), {});
      assert.deepEqual(local, before);
    });

    it('only reads own JSON fields', () => {
      assert.deepEqual(projectPortablePreferences(Object.create({ update: { npm: true }, analytics: { enabled: 'false' } })), {});
      assert.deepEqual(projectPortablePreferences({
        update: Object.create({ npm: true }),
        backup: Object.create({ includeRaw: true }),
        analytics: Object.create({ enabled: 'false' }),
      }), {});
    });

    it('rejects malformed roots and export-bearing sections', () => {
      [null, [], false, 'dummy-sensitive-value'].forEach((value) => {
        assert.throws(() => projectPortablePreferences(value), PortableConfigError, 'Invalid config; expected a JSON object.');
        ['update', 'backup'].forEach((section) => {
          assert.throws(() => projectPortablePreferences({ [section]: value }), PortableConfigError, `Invalid ${section}; expected a JSON object.`);
        });
      });
    });
  });

  describe('local-first restoration', () => {
    updateKeys.forEach((key) => {
      booleanCases.forEach(({ input, canonical }) => {
        it(`restores update.${key}=${JSON.stringify(input)} only over a newly filled default`, () => {
          const local = baseline();
          const { config, inclusionProposals } = restorePortablePreferences(local, {}, { update: { [key]: input } });
          assert.equal((config.update as ConfigObject)[key], canonical);
          assert.deepEqual(inclusionProposals, {});
          assert.deepEqual(local, baseline());
        });
      });
      [...booleanCases.map(({ input }) => input), ...invalidValues].forEach((value) => {
        it(`preserves the existing update.${key} choice ${JSON.stringify(value)}`, () => {
          const local = { update: { [key]: value }, custom: { preserve: true } };
          const { config } = restorePortablePreferences(local, local, { update: { [key]: 'true' } });
          assert.deepEqual(config, local);
        });
      });
      it(`ignores absent and invalid remote update.${key} values`, () => {
        [undefined, ...invalidValues].forEach((value) => {
          const local = baseline();
          const { config } = restorePortablePreferences(local, {}, { update: { [key]: value } });
          assert.deepEqual(config, local);
        });
        assert.deepEqual(restorePortablePreferences(baseline(), {}, {}).config, baseline());
      });
    });

    it('imports exact analytics opt-out over newly created defaults without importing consent', () => {
      assert.deepEqual(restorePortablePreferences(baseline(), {}, { analytics: { enabled: 'false' } }).config.analytics, { enabled: 'false' });
      [true, false, 'true', undefined, ...invalidValues].forEach((value) => {
        assert.deepEqual(restorePortablePreferences(baseline(), {}, { analytics: { enabled: value } }).config, baseline());
      });
    });

    ['true', 'false', true, false, ...invalidValues].forEach((value) => {
      it(`preserves preexisting analytics.enabled=${JSON.stringify(value)}`, () => {
        const local = { analytics: { enabled: value } };
        ['false', 'true'].forEach((remoteValue) => {
          assert.deepEqual(restorePortablePreferences(local, local, { analytics: { enabled: remoteValue } }).config, local);
        });
      });
    });

    inclusionKeys.forEach((key) => {
      it(`treats remote true backup.${key} as an unpersisted proposal and false as restorable`, () => {
        [true, 'true'].forEach((value) => {
          const local = baseline();
          const result = restorePortablePreferences(local, {}, { backup: { [key]: value } });
          assert.deepEqual(result.config, local);
          assert.deepEqual(result.inclusionProposals, { [key]: true });
          assert.deepEqual(resolveBackupInclusion(result.config), { includeRaw: false, includeDetailed: false });
          assert.deepEqual(restorePortablePreferences({}, {}, { backup: { [key]: value } }).config, {});
        });
        [false, 'false'].forEach((value) => {
          assert.deepEqual(restorePortablePreferences({}, {}, { backup: { [key]: value } }), {
            config: { backup: { [key]: 'false' } }, inclusionProposals: {},
          });
        });
      });

      it(`preserves every existing backup.${key} choice including invalid values`, () => {
        [...booleanCases.map(({ input }) => input), ...invalidValues].forEach((value) => {
          const local = { backup: { [key]: value } };
          [true, false].forEach((remoteValue) => {
            assert.deepEqual(restorePortablePreferences(local, local, { backup: { [key]: remoteValue } }), {
              config: local, inclusionProposals: {},
            });
          });
        });
      });

      it(`ignores invalid remote backup.${key}`, () => {
        [undefined, ...invalidValues].forEach((value) => {
          assert.deepEqual(restorePortablePreferences(baseline(), {}, { backup: { [key]: value } }), {
            config: baseline(), inclusionProposals: {},
          });
        });
      });
    });

    it('clones local state, retains its destination and unknown fields, and never imports remote unknowns', () => {
      const local = {
        backup: { id: 'selected-id', host: 'selected.example.test' },
        custom: { private: 'dummy-local-secret', nested: ['preserve'] },
        update: { futureLocal: { preserve: true } },
      };
      const original = structuredClone(local);
      const remote = {
        backup: { id: 'remote-id', host: 'remote.example.test', includeFuture: true },
        update: { futureRemote: true },
        custom: { private: 'dummy-remote-secret' },
        analytics: { installId: 'remote-install-id' },
      };
      const result = restorePortablePreferences(local, original, remote);
      assert.deepEqual(result, { config: local, inclusionProposals: {} });
      (result.config.custom as ConfigObject).private = 'changed-copy';
      assert.equal(local.custom.private, 'dummy-local-secret');
      assert.deepEqual(original, local);
      assert.equal(remote.custom.private, 'dummy-remote-secret');
    });

    it('ignores malformed remote sections independently, while rejecting malformed roots', () => {
      [null, [], true, 'dummy-sensitive-value'].forEach((value) => {
        assert.throws(() => restorePortablePreferences({}, {}, value), PortableConfigError, 'Invalid remote config; expected a JSON object.');
        assert.deepEqual(restorePortablePreferences({}, {}, { update: value, analytics: { enabled: 'false' } }).config, {
          analytics: { enabled: 'false' },
        });
        assert.deepEqual(restorePortablePreferences({}, {}, { backup: value, update: { npm: true } }).config, {
          update: { npm: 'true' },
        });
        assert.deepEqual(restorePortablePreferences({}, {}, { analytics: value, backup: { includeDetailed: false } }).config, {
          backup: { includeDetailed: 'false' },
        });
      });
    });

    it('rejects malformed local ancestors before creating any restored candidate', () => {
      ['update', 'backup', 'analytics'].forEach((key) => {
        const malformed = { [key]: false };
        assert.throws(() => restorePortablePreferences(malformed, {}, {}), PortableConfigError);
        assert.throws(() => restorePortablePreferences({}, malformed, {}), PortableConfigError);
      });
    });

    it('ignores inherited remote permissions and prototype-shaped unknown fields', () => {
      const remote = Object.create({ update: { npm: true }, analytics: { enabled: 'false' }, backup: { includeRaw: true } });
      assert.deepEqual(restorePortablePreferences({}, {}, remote), { config: {}, inclusionProposals: {} });
      assert.deepEqual(restorePortablePreferences({}, {}, {
        update: Object.create({ npm: true }),
        analytics: Object.create({ enabled: 'false' }),
        backup: Object.create({ includeRaw: true }),
      }), { config: {}, inclusionProposals: {} });
      const local = JSON.parse('{"__proto__":{"local":"keep"},"constructor":{"keep":true}}');
      const unsafeRemote = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
      assert.deepEqual(restorePortablePreferences(local, local, unsafeRemote).config, local);
      assert.isUndefined(({} as ConfigObject).polluted);
    });
  });

  describe('inclusion resolution before discovery', () => {
    it('defaults only missing groups to false and ignores unknown future groups', () => {
      assert.deepEqual(resolveBackupInclusion({}), { includeRaw: false, includeDetailed: false });
      assert.deepEqual(resolveBackupInclusion({ backup: { includeFuture: true } }), { includeRaw: false, includeDetailed: false });
      assert.deepEqual(resolveBackupInclusion({ backup: Object.create({ includeRaw: true, includeDetailed: true }) }), {
        includeRaw: false, includeDetailed: false,
      });
    });

    inclusionKeys.forEach((key) => {
      booleanCases.forEach(({ input, canonical }) => {
        it(`resolves backup.${key}=${JSON.stringify(input)} without reading other preferences`, () => {
          assert.deepEqual(resolveBackupInclusion({ backup: { [key]: input }, update: 'unrelated' }), {
            includeRaw: false, includeDetailed: false, [key]: canonical === 'true',
          });
        });
      });
      invalidValues.forEach((value) => {
        it(`rejects backup.${key}=${JSON.stringify(value)} before discovery`, () => {
          assert.throws(() => resolveBackupInclusion({ backup: { [key]: value } }), PortableConfigError, `Invalid backup.${key}; expected true or false.`);
        });
      });
    });

    it('rejects invalid root or backup objects', () => {
      [null, [], true, 'dummy-sensitive-value'].forEach((value) => {
        assert.throws(() => resolveBackupInclusion(value), PortableConfigError, 'Invalid config; expected a JSON object.');
        assert.throws(() => resolveBackupInclusion({ backup: value }), PortableConfigError, 'Invalid backup; expected a JSON object.');
      });
    });
  });

  describe('private projection CLI', () => {
    let temporaryRoot: string;
    let configPath: string;
    const cliPath = path.join(__dirname, '..', 'config', 'portable.ts');
    const runCli = (args: string[] = [configPath], nodeArgs: string[] = []) => spawnSync(process.execPath, [...nodeArgs, cliPath, ...args], {
      encoding: 'utf8',
      env: testChildEnvironment(),
    });

    beforeEach(() => {
      temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-portable-cli-'));
      configPath = path.join(temporaryRoot, 'dummy-sensitive-path.json');
    });

    afterEach(() => {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    it('emits only projected JSON and leaves the source unchanged', () => {
      const contents = JSON.stringify({
        update: { npm: true }, backup: { id: 'private-id', includeRaw: false },
        analytics: { enabled: 'false' }, custom: 'dummy-sensitive-value',
      });
      fs.writeFileSync(configPath, contents);
      const result = runCli();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { update: { npm: 'true' }, backup: { includeRaw: 'false' }, analytics: { enabled: 'false' } });
      assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
    });

    it('emits no partial snapshot when a later selected preference is invalid', () => {
      fs.writeFileSync(configPath, JSON.stringify({ update: { cleanup: true, nvm: 'dummy-sensitive-value' } }));
      const result = runCli();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ballin preferences: Invalid update.nvm; expected true or false.\n');
    });

    it('never substitutes an empty projection for a missing, unreadable or malformed source', () => {
      const missing = runCli();
      const directory = runCli([temporaryRoot]);
      fs.writeFileSync(configPath, '{dummy-sensitive-value');
      const malformed = runCli();
      [missing, directory, malformed].forEach((result) => {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.notInclude(result.stderr, 'dummy-sensitive');
        assert.notInclude(result.stderr, temporaryRoot);
      });
      assert.equal(missing.stderr, 'ballin preferences: Unable to read config.\n');
      assert.equal(directory.stderr, missing.stderr);
      assert.equal(malformed.stderr, 'ballin preferences: Config is not valid JSON.\n');
    });

    it('requires exactly one input filename', () => {
      [[], [configPath, 'extra-sensitive-value']].forEach((args) => {
        const result = runCli(args);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'ballin preferences: Expected one config file.\n');
      });
    });

    it('does not expose unexpected serialization errors', () => {
      fs.writeFileSync(configPath, '{}');
      const preloadPath = path.join(temporaryRoot, 'serialization-failure.cjs');
      fs.writeFileSync(preloadPath, 'JSON.stringify = () => { throw new Error("dummy-sensitive-value"); };\n');
      const result = runCli([configPath], ['--require', preloadPath]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ballin preferences: Unable to export portable preferences.\n');
    });
  });
});
