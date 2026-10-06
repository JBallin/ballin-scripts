const fs = require('fs');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { withTemporaryStatus, clearTemporaryStatus } = require('../commands/temporaryStatus.ts');
const { writeStdoutLine, writeStderrLine, runCommand } = require('../commands/commandHelpers.ts');

describe('temporary terminal status', () => {
  let output: string; let restore: () => void;
  beforeEach(() => {
    output = '';
    const write = fs.writeSync;
    const streams = [process.stdin, process.stdout, process.stderr];
    const columns = Object.getOwnPropertyDescriptor(process.stderr, 'columns');
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    const env = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
    streams.forEach((stream) => Object.defineProperty(stream, 'isTTY', { configurable: true, value: true }));
    process.env.TERM = 'xterm'; delete process.env.NO_COLOR;
    Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 80 });
    fs.writeSync = (fd: number, text: string) => { assert.equal(fd, 2); output += text; return text.length; };
    restore = () => {
      clearTemporaryStatus(); fs.writeSync = write;
      if (columns) Object.defineProperty(process.stderr, 'columns', columns); else Reflect.deleteProperty(process.stderr, 'columns');
      streams.forEach((stream, index) => {
        if (descriptors[index]) Object.defineProperty(stream, 'isTTY', descriptors[index]);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    };
  });
  afterEach(() => restore());
  it('renders before synchronous work and clears on completion without listener leaks', async () => {
    const listeners = process.listenerCount('SIGINT');
    assert.equal(withTemporaryStatus('Working...', () => { assert.equal(output, 'Working...'); return 42; }), 42);
    assert.equal(output, 'Working...\r\x1b[2K');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(process.listenerCount('SIGINT'), listeners);
  });
  it('clears before normal output and preserves thrown failures', () => {
    for (const writer of [writeStdoutLine, writeStderrLine]) {
      output = '';
      assert.throws(() => withTemporaryStatus('Working...', () => {
        writer('fixture result'); assert.equal(output, 'Working...\r\x1b[2K'); throw new Error('fixture');
      }), 'fixture');
      assert.equal(output, 'Working...\r\x1b[2K');
    }
  });
  it('clears before inherited child output without redrawing over diagnostics', () => {
    withTemporaryStatus('Working...', () => {
      runCommand(process.execPath, ['-e', 'process.stderr.write("fixture diagnostic without newline")'], { stdio: 'inherit' });
      assert.equal(output, 'Working...\r\x1b[2K');
      runCommand(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'inherit'] });
      assert.equal(output, 'Working...\r\x1b[2K');
    });
    assert.equal(output, 'Working...\r\x1b[2K');
  });
  it('preserves an inherited diagnostic without a trailing newline', () => {
    const result = spawnSync(process.execPath, ['-e', `
      for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
      require(${JSON.stringify(require.resolve('../commands/temporaryStatus.ts'))}).withTemporaryStatus('Working...', () => {
        require(${JSON.stringify(require.resolve('../commands/commandHelpers.ts'))}).runCommand(process.execPath, ['-e', 'process.stderr.write("fixture diagnostic")'], { stdio: 'inherit' });
      });
    `], { encoding: 'utf8', env: testChildEnvironment({ TERM: 'xterm' }) });
    assert.equal(result.status, 0); assert.equal(result.stderr, 'Working...\r\x1b[2Kfixture diagnostic');
  });
  it('handles nested status boundaries without clearing the newer line twice', () => {
    withTemporaryStatus('Outer...', () => withTemporaryStatus('Inner...', () => clearTemporaryStatus()));
    assert.equal(output, 'Outer...\r\x1b[2KInner...\r\x1b[2K');
  });
  for (const mode of ['stdin', 'stdout', 'stderr', 'dumb', 'NO_COLOR'] as const) {
    it(`leaves output unchanged in ${mode} mode`, () => {
      if (mode === 'dumb') process.env.TERM = 'dumb';
      else if (mode === 'NO_COLOR') process.env.NO_COLOR = '1';
      else Object.defineProperty({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }[mode], 'isTTY', { configurable: true, value: false });
      assert.equal(withTemporaryStatus('Working...', () => 7), 7); assert.equal(output, '');
    });
    it(`can show plain immediate feedback in ${mode} mode`, () => {
      if (mode === 'dumb') process.env.TERM = 'dumb';
      else if (mode === 'NO_COLOR') process.env.NO_COLOR = '1';
      else Object.defineProperty({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }[mode], 'isTTY', { configurable: true, value: false });
      assert.throws(() => withTemporaryStatus('Opening...', () => {
        assert.equal(output, 'Opening...\n'); throw new Error('fixture operation failure');
      }, true), 'fixture operation failure');
      assert.equal(output, 'Opening...\n');
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`preserves native ${signal} during synchronous child work`, () => {
      const script = `
        for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
        const { spawn, spawnSync } = require('child_process');
        spawn(process.execPath, ['-e', 'setTimeout(() => process.kill(' + process.pid + ', ${JSON.stringify(signal)}), 50)'], { stdio: 'ignore' });
        require(${JSON.stringify(require.resolve('../commands/temporaryStatus.ts'))}).withTemporaryStatus('Working...', () => {
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 150)']);
          process.stderr.write('continued after interruption');
        });
        setTimeout(() => {}, 250);
      `;
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: testChildEnvironment({ TERM: 'xterm' }) });
      assert.equal(result.signal, signal); assert.equal(result.stderr, 'Working...');
    });
  }
  it('preserves native group interruption of synchronous child work', async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', `
      for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
      require(${JSON.stringify(require.resolve('../commands/temporaryStatus.ts'))}).withTemporaryStatus('Working...', () => {
        require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
      });
    `], { detached: true, env: testChildEnvironment({ TERM: 'xterm' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const completion = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code: number | null, signal: string | null) => {
        try { assert.isNull(code); assert.equal(signal, 'SIGINT'); resolve(); } catch (error) { reject(error); }
      });
    });
    child.stdout.once('data', () => process.kill(-child.pid, 'SIGINT'));
    try { await completion; assert.equal(stderr, 'Working...'); }
    finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Child group already exited. */ } }
  });
  it('skips narrow terminals and ignores optional display failures', () => {
    Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 5 });
    assert.equal(withTemporaryStatus('Working...', () => 1), 1); assert.equal(output, '');
    assert.equal(withTemporaryStatus('Opening...', () => 1, true), 1); assert.equal(output, 'Opening...\n');
    Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 80 });
    fs.writeSync = () => { throw new Error('closed terminal'); };
    assert.equal(withTemporaryStatus('Working...', () => 2), 2);
  });
  it('clears on explicit process exit', () => {
    const result = spawnSync(process.execPath, ['-e', `
      for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
      require(${JSON.stringify(require.resolve('../commands/temporaryStatus.ts'))}).withTemporaryStatus('Working...', () => process.exit(3));
    `], { encoding: 'utf8', env: testChildEnvironment({ TERM: 'xterm' }) });
    assert.equal(result.status, 3); assert.equal(result.stderr, 'Working...\r\x1b[2K');
  });
});
