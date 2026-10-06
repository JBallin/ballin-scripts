const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testChildEnvironment } = require('./helpers/environment.ts');

const configPath = path.resolve(__dirname, '..', '.mocharc.js');
const mochaPath = require.resolve('mocha/bin/_mocha');

describe('Mocha worker selection', () => {
  for (const [cpus, jobs] of [[1, 1], [2, 1], [3, 1], [4, 2], [8, 2]]) {
    it(`uses ${jobs} job${jobs === 1 ? '' : 's'} with ${cpus} available CPUs`, () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-mocha-config-'));
      const preloadPath = path.join(tempDir, 'cpu.cjs');
      const fixturePath = path.join(tempDir, 'fixture.js');
      try {
        fs.writeFileSync(preloadPath, `
          const assert = require('node:assert/strict');
          require('node:os').availableParallelism = () => ${cpus};
          assert.equal(require(${JSON.stringify(configPath)}).jobs, ${jobs});
        `);
        fs.writeFileSync(fixturePath, `
          const assert = require('node:assert/strict');
          describe('isolated fixture', () => {
            it('uses the selected execution mode', () => {
              assert.equal(process.env.MOCHA_WORKER_ID !== undefined, ${jobs > 1});
            });
          });
        `);
        const result = spawnSync(process.execPath, [
          '--require', preloadPath, mochaPath,
          '--config', configPath, '--no-package', '--parallel',
          '--extension', 'js', '--reporter', 'dot', fixturePath,
        ], {
          cwd: tempDir,
          encoding: 'utf8',
          env: testChildEnvironment({ HOME: tempDir, TMPDIR: tempDir }),
          timeout: 8000,
        });
        assert.isUndefined(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.include(result.stdout, '1 passing');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});
