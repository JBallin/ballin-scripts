const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commandExists,
  isDirectory,
  readCommandOutput,
  readPromptLine,
  reportSpawnError,
  runCommand,
  runNodeScript,
  spawnResultStatus,
  requireUninterrupted,
  rethrowInterruption,
  CommandInterrupted,
} = require('../commands/commandHelpers.ts');

describe('command helpers', () => {
  it('preserves explicit interruption while retaining real spawn-error classification', () => {
    for (const result of [{ signal: 'SIGINT', status: null }, { signal: 'SIGTERM', status: null }, { status: 130 }, { status: 143 }]) {
      try { requireUninterrupted(result); assert.fail('expected interruption'); } catch (error) {
        assert.instanceOf(error, CommandInterrupted);
        assert.equal((error as { status: number }).status, result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : result.status);
        assert.throws(() => rethrowInterruption(error), CommandInterrupted);
      }
    }
    for (const result of [{ status: 1 }, { status: null, signal: 'SIGKILL' },
      { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } },
      { status: 130, error: { code: 'ENOBUFS' } }]) assert.doesNotThrow(() => requireUninterrupted(result));
    assert.doesNotThrow(() => rethrowInterruption(new Error('ordinary failure')));
  });
  for (const code of ['EAGAIN', 'EBADF', 'secret-token', undefined, 123]) {
    it(`preserves prompt read failures with only a recognized system code: ${code}`, () => {
      const originalRead = fs.readSync;
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      const failure = Object.assign(new Error('credential content must stay private'), { code });
      let stdout = ''; let stderr = '';
      fs.readSync = () => { throw failure; };
      process.stdout.write = ((text: string) => { stdout += text; return true; }) as typeof process.stdout.write;
      process.stderr.write = ((text: string) => { stderr += text; return true; }) as typeof process.stderr.write;
      try {
        assert.throws(() => readPromptLine('Answer: '), failure);
      } finally {
        fs.readSync = originalRead;
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }
      assert.equal(stdout, 'Answer: ');
      assert.equal(stderr, `Unable to read prompt input (stdin read: ${['EAGAIN', 'EBADF'].includes(String(code)) ? code : 'unknown'}).\n`);
      assert.notInclude(stdout + stderr, 'credential content');
      assert.notInclude(stdout + stderr, 'secret-token');
    });
  }
  it('preserves the input error when stderr is unavailable', () => {
    const read = fs.readSync;
    const stderrWrite = process.stderr.write;
    const stdoutWrite = process.stdout.write;
    const failure = Object.assign(new Error('input failed'), { code: 'EBADF' });
    fs.readSync = () => { throw failure; };
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = () => { throw new Error('stderr unavailable'); };
    try { assert.throws(() => readPromptLine('Answer: '), failure); } finally {
      fs.readSync = read;
      process.stderr.write = stderrWrite;
      process.stdout.write = stdoutWrite;
    }
  });
  it('enforces string encoding and direct execution at runtime', () => {
    const result = runCommand(process.execPath, [
      '-e',
      'process.stdout.write("direct execution")',
    ], {
      encoding: 'buffer',
      shell: path.join(__dirname, 'missing-shell'),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, 'direct execution');
  });

  it('resolves explicit command paths and handles missing PATH safely', () => {
    assert.isTrue(commandExists(process.execPath, { env: { PATH: '' } }));
    assert.isFalse(commandExists('/definitely/missing/command', { env: { PATH: '' } }));
    assert.isFalse(commandExists('node', { env: { PATH: '' } }));
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      assert.isFalse(commandExists('node'));
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
    }
    assert.isTrue(isDirectory(__dirname));
    assert.isFalse(isDirectory(path.join(__dirname, 'missing-directory')));
  });

  it('returns only successful command output and runs Node scripts directly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-command-helpers-'));
    const scriptPath = path.join(tempDir, 'script.js');
    fs.writeFileSync(scriptPath, 'process.stdout.write("node script output")');
    try {
      assert.equal(readCommandOutput(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
      assert.isNull(readCommandOutput(process.execPath, ['-e', 'process.exit(7)']));
      assert.equal(runNodeScript(scriptPath).stdout, 'node script output');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports permission and generic spawn failures with shell-compatible statuses', () => {
    const originalWrite = process.stderr.write;
    let stderr = '';
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(reportSpawnError('tool', Object.assign(new Error('denied'), { code: 'EACCES' })), 126);
      assert.equal(reportSpawnError('tool', new Error('unexpected spawn failure')), 1);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(stderr, 'tool: Permission denied\nunexpected spawn failure\n');
  });

  it('normalizes known, unknown, and absent child-process termination statuses', () => {
    const result = (signal: NodeJS.Signals | null, status: number | null) => ({
      signal,
      status,
      stdout: '',
      stderr: '',
    });

    assert.equal(spawnResultStatus(result('SIGTERM', null)), 143);
    assert.equal(spawnResultStatus(result('SIGUNKNOWN' as NodeJS.Signals, 9)), 9);
    assert.equal(spawnResultStatus(result(null, null)), 1);
    assert.equal(spawnResultStatus(result(null, 7)), 7);
  });
});
