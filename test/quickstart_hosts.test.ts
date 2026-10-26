const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { configuredBackupDestination, normalizeBackupHost, resolveBackupSetupHost } = require('../commands/backup_config.ts');

describe('Quickstart bootstrap host parity', () => {
  for (const kind of ['dangling link', 'directory', 'malformed JSON', 'unreadable file']) {
    it(`refuses ${kind} configuration rather than selecting a default host`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-host-read-'));
      const file = path.join(home, '.ballin-scripts/ballin.config.json');
      try {
        fs.mkdirSync(path.dirname(file));
        if (kind === 'dangling link') fs.symlinkSync(path.join(home, 'missing'), file);
        else if (kind === 'directory') fs.mkdirSync(file);
        else fs.writeFileSync(file, kind === 'malformed JSON' ? '{' : '{}', { mode: kind === 'unreadable file' ? 0 : 0o600 });
        const result = spawnSync('/bin/bash', ['-c', 'source "$HOST_SOURCE"; node_tool="$HOST_NODE"; backup_setup_host'], {
          encoding: 'utf8', timeout: 5000,
          env: testChildEnvironment({ HOME: home, HOST_SOURCE: path.resolve(__dirname, '../quickstart.sh'), HOST_NODE: process.execPath }),
        });
        assert.isUndefined(result.error);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.isTrue(fs.lstatSync(file).isSymbolicLink() === (kind === 'dangling link'));
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }

  const repository = { id: 'R_fixture', ownerId: 'U_fixture', name: 'backups', branch: 'main' };
  const configs = [{}, { backup: { host: 'stale.example.com' } },
    { backup: { repository } }, { backup: { repository: { ...repository, host: 'git.example.com' } } },
    { backup: { repository: { ...repository, host: 'fixture.ghe.com' } } },
    { backup: { repository: { ...repository, host: '' } } }, { backup: { id: 'old-gist' } },
    { backup: { repository: true } }, { backup: null }, { analytics: [] }, { update: null }];
  for (const config of configs) {
    it(`matches destination and hostname rules for ${JSON.stringify(config)}`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-bootstrap-host-'));
      try {
        fs.mkdirSync(path.join(home, '.ballin-scripts'));
        fs.writeFileSync(path.join(home, '.ballin-scripts/ballin.config.json'), JSON.stringify(config));
        for (const input of [undefined, 'github.com', 'GIT.EXAMPLE.COM', 'fixture.ghe.com', 'https://git.example.com', 'bad_host', 'K.example.com']) {
          let expected: string | undefined; let invalid = false;
          try {
            readSetupConfigContext(path.join(home, '.ballin-scripts/ballin.config.json'));
            if (['invalid', 'legacy-gist'].includes(configuredBackupDestination(config).kind)) throw Error();
            const normalized = input === undefined ? undefined : normalizeBackupHost(input);
            if (normalized === null) throw Error();
            expected = resolveBackupSetupHost(config, normalized);
          } catch { invalid = true; }
          const result = spawnSync('/bin/bash', ['-c',
            'source "$HOST_SOURCE"; node_tool="$HOST_NODE"; backup_setup_host "$@"', 'host', ...(input === undefined ? [] : [input])], {
            encoding: 'utf8', timeout: 5000,
            env: testChildEnvironment({ HOME: home, HOST_SOURCE: path.resolve(__dirname, '../quickstart.sh'), HOST_NODE: process.execPath }),
          });
          assert.isUndefined(result.error);
          assert.equal(result.status, invalid ? 1 : 0, result.stderr);
          if (!invalid) assert.equal(result.stdout, expected ?? '');
        }
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }
});
