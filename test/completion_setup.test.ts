const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activationLine, appendActivation, completionTarget, offerCompletionSetup } = require('../commands/completion_setup.ts');

describe('optional completion setup', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const response = (text: string) => () => ({ text, eof: false });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-completion-'));
    env = { HOME: home, SHELL: '/bin/zsh', PATH: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = () => completionTarget(env, response(env.ZDOTDIR ?? 'home'));
  const offer = (answers: string[], interactive = true, onPrompt?: (text: string) => void) => {
    const output: string[] = [];
    const choices = env.SHELL === '/bin/zsh' ? [env.ZDOTDIR ?? 'home', ...answers] : answers;
    offerCompletionSetup('https://example.test/install', {
      env, interactive, write: (text: string) => output.push(text),
      prompt: (prompt: string) => { onPrompt?.(prompt); const text = choices.shift(); return { text: text ?? '', eof: text === undefined }; },
    });
    return output.join('\n');
  };
  it('shows the profile and exact line, defaults off, and skips noninteractive/EOF input', () => {
    const profile = path.join(home, '.zshrc');
    const output = offer(['']);
    assert.include(output, profile);
    assert.include(output, activationLine('zsh'));
    assert.isFalse(fs.existsSync(profile));
    assert.include(offer([], false), 'Enable shell completion later:\nhttps://example.test/install#shell-completion');
    offer([]);
    assert.isFalse(fs.existsSync(profile));
  });
  it('creates only the standard file privately and reports activation/reload', () => {
    assert.include(offer(['y']), 'Shell completion enabled');
    const profile = path.join(home, '.zshrc');
    assert.strictEqual(fs.readFileSync(profile, 'utf8'), `${activationLine('zsh')}\n`);
    assert.strictEqual(fs.statSync(profile).mode & 0o777, 0o600);
    assert.include(offer(['Y']), 'already enabled');
    assert.strictEqual(fs.readFileSync(profile, 'utf8'), `${activationLine('zsh')}\n`);
  });
  for (const contents of ['', 'export EDITOR=vim', 'export EDITOR=vim\n', 'one\r\ntwo', 'one\r\ntwo\r\n']) {
    it(`preserves exact original bytes and mode: ${JSON.stringify(contents)}`, () => {
      const profile = path.join(home, '.zshrc');
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      assert.isTrue(appendActivation(target()));
      const newline = '\n';
      const separator = contents && !contents.endsWith('\n') ? newline : '';
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), `${contents}${separator}${activationLine('zsh')}${newline}`);
      assert.strictEqual(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(appendActivation(target()));
    });
  }
  it('uses an existing absolute ZDOTDIR without creating directories', () => {
    env.ZDOTDIR = path.join(home, 'zsh');
    fs.mkdirSync(env.ZDOTDIR);
    assert.strictEqual(target().profile, path.join(env.ZDOTDIR, '.zshrc'));
    env.ZDOTDIR = 'relative';
    assert.isNull(target());
    env.ZDOTDIR = path.join(home, 'missing');
    assert.include(offer(['y']), 'could not finish');
    assert.isFalse(fs.existsSync(env.ZDOTDIR));
  });
  it('falls back for missing, relative, or unsupported shell/home evidence', () => {
    for (const overrides of [{ HOME: '' }, { HOME: 'relative' }, { SHELL: '' }, { SHELL: 'zsh' }, { SHELL: '/bin/fish' }]) {
      assert.isNull(completionTarget({ ...env, ...overrides }, response('')));
    }
  });
  it('clarifies Bash startup choice and honors login-file precedence', () => {
    env.SHELL = '/bin/bash';
    assert.isNull(completionTarget(env, response('')));
    assert.isNull(completionTarget(env, () => ({ text: 'login', eof: true })));
    assert.strictEqual(completionTarget(env, response('bashrc')).profile, path.join(home, '.bashrc'));
    assert.strictEqual(completionTarget(env, response('login')).profile, path.join(home, '.bash_profile'));
    fs.writeFileSync(path.join(home, '.profile'), 'shared shell file');
    assert.isNull(completionTarget(env, response('login')));
    fs.writeFileSync(path.join(home, '.bash_login'), 'login');
    assert.strictEqual(completionTarget(env, response('login')).profile, path.join(home, '.bash_login'));
    fs.writeFileSync(path.join(home, '.bash_profile'), 'profile');
    assert.strictEqual(completionTarget(env, response('login')).profile, path.join(home, '.bash_profile'));
    assert.include(offer(['login', 'y']), activationLine('bash'));
    assert.strictEqual(fs.readFileSync(path.join(home, '.profile'), 'utf8'), 'shared shell file');
  });
  it('refuses links, directories, and changes made after confirmation', () => {
    const profile = path.join(home, '.zshrc');
    const outside = path.join(home, 'untouched');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, profile);
    assert.include(offer(['y']), 'could not finish');
    fs.unlinkSync(profile);
    fs.mkdirSync(profile);
    assert.include(offer(['y']), 'could not finish');
    fs.rmdirSync(profile);
    assert.include(offer(['y'], true, (prompt) => { if (prompt === 'Enable shell completion? [y/N] ') fs.symlinkSync(outside, profile); }), 'could not finish');
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
  });
  it('contains filesystem and prompt failures with manual fallback', () => {
    const output: string[] = [];
    offerCompletionSetup('guide', { env, interactive: true, write: (text: string) => output.push(text), prompt: () => { throw new Error('input failed'); } });
    assert.include(output.join('\n'), 'Ballin remains installed');
    assert.include(output.join('\n'), 'guide#shell-completion');
  });
  it('uses real default prompting and environment only inside an isolated child', () => {
    const script = `process.stdin.isTTY = true; require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'completion_setup.ts'))}).offerCompletionSetup('guide');`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', input: 'home\ny\n', env: testChildEnvironment(env) });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Enable shell completion? [y/N]');
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), activationLine('zsh'));
  });
  it('rejects a startup directory that is a file or link', () => {
    const directory = path.join(home, 'not-directory');
    fs.writeFileSync(directory, 'keep');
    env.ZDOTDIR = directory;
    assert.include(offer(['y']), 'could not finish');
    fs.unlinkSync(directory);
    fs.symlinkSync(home, directory);
    assert.include(offer(['y']), 'could not finish');
  });
  it('reports open failures without changing profile bytes', () => {
    const original = fs.openSync;
    fs.openSync = () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error; };
    try { assert.include(offer(['y']), 'could not finish'); } finally { fs.openSync = original; }
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
  });
  it('rejects a file replaced between open and inspection', () => {
    const original = fs.fstatSync;
    fs.fstatSync = (fd: number) => ({ ...original(fd), isFile: () => false });
    try { assert.throws(() => appendActivation(target()), 'Startup file changed'); } finally { fs.fstatSync = original; }
    assert.strictEqual(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), '');
  });
  it('contains unreadable Bash login-file inspection failures', () => {
    env.SHELL = '/bin/bash';
    const original = fs.lstatSync;
    fs.lstatSync = (file: string, ...args: unknown[]) => {
      if (file === path.join(home, '.bash_profile')) throw new Error('inspection failed');
      return original(file, ...args);
    };
    try { assert.include(offer(['login']), 'could not finish'); } finally { fs.lstatSync = original; }
  });

  it('keeps the documented shared .profile activation safe in POSIX shells', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'installation.md'), 'utf8');
    const sharedLine = guide.match(/```sh\n([^`]+)```/u)?.[1];
    assert.exists(sharedLine);
    fs.mkdirSync(path.join(home, '.ballin-scripts', 'completions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ballin-scripts', 'completions', 'ballin.bash'), 'printf activated');
    fs.writeFileSync(path.join(home, '.profile'), sharedLine);
    for (const shell of ['/bin/sh', '/bin/bash']) {
      const script = `${shell === '/bin/sh' ? 'unset BASH_VERSION; ' : ''}. "$HOME/.profile"; printf finished`;
      const result = spawnSync(shell, ['-c', script], { encoding: 'utf8', env: testChildEnvironment(env) });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, shell === '/bin/bash' ? 'activatedfinished' : 'finished');
    }
  });

  it('requires explicit zsh directory selection without reading or sourcing .zshenv', () => {
    const directory = path.join(home, 'custom-zsh');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${directory}\nprintf touched > "${home}/startup-ran"\n`);
    assert.isNull(completionTarget(env, response('')));
    assert.isNull(completionTarget(env, () => ({ text: 'home', eof: true })));
    assert.strictEqual(completionTarget(env, response(directory)).profile, path.join(directory, '.zshrc'));
    const script = `process.stdin.isTTY = true; require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'completion_setup.ts'))}).offerCompletionSetup('guide');`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', input: `${directory}\ny\n`, env: testChildEnvironment(env) });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    assert.isFalse(fs.existsSync(path.join(home, 'startup-ran')));
    assert.include(fs.readFileSync(path.join(directory, '.zshrc'), 'utf8'), activationLine('zsh'));
  });
  for (const ending of ['\\', '\\'.repeat(3), '\\\n', '\\\r\n']) {
    it(`leaves a continuation boundary unchanged: ${JSON.stringify(ending)}`, () => {
      const profile = path.join(home, '.zshrc');
      const contents = `value=original${ending}`;
      fs.writeFileSync(profile, contents);
      assert.include(offer(['y']), 'could not finish');
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), contents);
    });
  }
  it('allows an even trailing backslash run without changing the original bytes', () => {
    const profile = path.join(home, '.zshrc');
    const contents = 'value=original\\\\';
    fs.writeFileSync(profile, contents);
    assert.isTrue(appendActivation(target()));
    assert.strictEqual(fs.readFileSync(profile, 'utf8'), `${contents}\n${activationLine('zsh')}\n`);
  });
  for (const contents of ['', 'keep', 'keep\r\n']) {
    it(`restores original bytes and mode after a short append and ENOSPC: ${JSON.stringify(contents)}`, () => {
      const profile = path.join(home, '.zshrc');
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const original = fs.writeFileSync;
      fs.writeFileSync = (fd: number, appended: Buffer) => {
        fs.writeSync(fd, appended.subarray(0, 12));
        const error = new Error('quota exhausted') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      };
      try { assert.include(offer(['y']), 'could not finish'); } finally { fs.writeFileSync = original; }
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), contents);
      assert.strictEqual(fs.statSync(profile).mode & 0o777, 0o640);
    });
  }
  it('identifies the profile if rollback itself fails', () => {
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, 'keep');
    const originalWrite = fs.writeFileSync;
    const originalTruncate = fs.ftruncateSync;
    fs.writeFileSync = (fd: number, appended: Buffer) => { fs.writeSync(fd, appended.subarray(0, 12)); throw new Error('short write'); };
    fs.ftruncateSync = () => { throw new Error('I/O failure'); };
    try {
      const output = offer(['y']);
      assert.include(output, `Inspect ${profile}`);
      assert.include(output, 'before reloading');
      assert.include(output, 'Ballin remains installed');
    } finally { fs.writeFileSync = originalWrite; fs.ftruncateSync = originalTruncate; }
  });
  for (const change of ['larger', 'smaller', 'original-prefix', 'appended-suffix', 'short-read']) {
    it(`preserves another writer's changes instead of truncating them: ${change}`, () => {
      const profile = path.join(home, '.zshrc');
      fs.writeFileSync(profile, 'keep');
      const originalWrite = fs.writeFileSync;
      const originalRead = fs.readSync;
      fs.writeFileSync = (fd: number, appended: Buffer) => {
        if (change === 'larger') fs.writeSync(fd, Buffer.alloc(appended.length + 1, 'x'));
        else if (change === 'smaller') fs.ftruncateSync(fd, 1);
        else if (change === 'original-prefix') { fs.ftruncateSync(fd, 0); fs.writeSync(fd, 'user'); }
        else if (change === 'appended-suffix') fs.writeSync(fd, 'user');
        else { fs.writeSync(fd, appended.subarray(0, 12)); fs.readSync = () => 0; }
        throw new Error('write failed');
      };
      try { assert.include(offer(['y']), `Inspect ${profile}`); }
      finally { fs.writeFileSync = originalWrite; fs.readSync = originalRead; }
      const append = Buffer.from(`\n${activationLine('zsh')}\n`);
      const expected = change === 'larger' ? Buffer.concat([Buffer.from('keep'), Buffer.alloc(append.length + 1, 'x')])
        : change === 'smaller' ? Buffer.from('k')
        : change === 'original-prefix' ? Buffer.from('user')
        : change === 'appended-suffix' ? Buffer.from('keepuser')
        : Buffer.concat([Buffer.from('keep'), append.subarray(0, 12)]);
      assert.deepEqual(fs.readFileSync(profile), expected);
    });
  }

  for (const contents of ['# existing comment\r\n', '# existing comment\r\n# no final newline']) {
    it(`loads Bash completion after preserving CRLF profile bytes: ${JSON.stringify(contents)}`, () => {
      env.SHELL = '/bin/bash';
      const profile = path.join(home, '.bashrc');
      fs.writeFileSync(profile, contents);
      const assetDirectory = path.join(home, '.ballin-scripts', 'completions');
      fs.mkdirSync(assetDirectory, { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'completions', 'ballin.bash'), path.join(assetDirectory, 'ballin.bash'));
      const bashTarget = completionTarget(env, response('bashrc'));
      assert.isTrue(appendActivation(bashTarget));
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; complete -p ballin'], {
        encoding: 'utf8', env: testChildEnvironment(env),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stderr, '');
      assert.include(result.stdout, 'complete -F _ballin_completion ballin');
      const expected = `${contents}${contents.endsWith('\n') ? '' : '\n'}${activationLine('bash')}\n`;
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), expected);
      assert.isFalse(appendActivation(bashTarget));
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), expected);
    });
  }

  for (const ending of ['\r\n', '\r', '\nvalid-and-malformed']) {
    it(`requests manual repair of an existing CRLF activation without changing bytes: ${JSON.stringify(ending)}`, () => {
      env.SHELL = '/bin/bash';
      const profile = path.join(home, '.bashrc');
      const line = activationLine('bash');
      const contents = ending === '\nvalid-and-malformed' ? `${line}\n${line}\r\n` : `# user settings\n${line}${ending}`;
      fs.writeFileSync(profile, contents);
      const output = offer(['bashrc', 'y']);
      assert.include(output, `The completion activation in ${profile} has a trailing carriage return`);
      assert.include(output, 'Replace only that activation line manually');
      assert.include(output, 'using LF before reloading');
      assert.notInclude(output, 'already enabled');
      assert.notInclude(output, 'Shell completion enabled.');
      assert.strictEqual(fs.readFileSync(profile, 'utf8'), contents);
    });
  }

});
