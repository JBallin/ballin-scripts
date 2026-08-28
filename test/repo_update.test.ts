const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoUpdatePath = path.join(__dirname, '..', 'commands', 'repo_update.ts');

describe('repository update CLI', () => {
  let tempDir: string;
  let binDir: string;
  let installedRepo: string;
  let gitLog: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-repo-update-'));
    binDir = path.join(tempDir, 'bin');
    installedRepo = path.join(tempDir, 'repo');
    gitLog = path.join(tempDir, 'git.log');
    fs.mkdirSync(binDir);
    fs.mkdirSync(installedRepo);
    fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
exit 0
`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints usage and fails when the repository path is missing', () => {
    const result = spawnSync(process.execPath, [repoUpdatePath], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'Usage: repo_update.ts <repo-dir>\n');
    assert.equal(result.stderr, '');
  });

  it('updates an installed repository through the direct CLI with stubbed git', () => {
    const result = spawnSync(process.execPath, [repoUpdatePath, installedRepo], {
      encoding: 'utf8',
      env: {
        PATH: binDir,
        FAKE_GIT_LOG: gitLog,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readFileSync(gitLog, 'utf8').trim().split('\n'), [
      'fetch origin +main:refs/remotes/origin/main',
      'checkout main',
      'merge origin/main',
    ]);
  });
});
