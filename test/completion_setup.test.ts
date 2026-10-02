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
  const target = () => completionTarget(env, response(''));
  const offer = (answers: string[], interactive = true, onPrompt?: () => void) => {
    const output: string[] = [];
    offerCompletionSetup('https://example.test/install', {
      env, interactive, write: (text: string) => output.push(text),
      prompt: () => { onPrompt?.(); const text = answers.shift(); return { text: text ?? '', eof: text === undefined }; },
    });
    return output.join('\n');
  };
  it('shows the profile and exact line, defaults off, and skips noninteractive/EOF input', () => {
    const profile = path.join(home, '.zshrc');
    const output = offer(['']);
    assert.include(output, profile);
    assert.include(output, activationLine('zsh'));
    assert.isFalse(fs.existsSync(profile));
    assert.include(offer([], false), '#shell-completion');
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
      const newline = contents.includes('\r\n') ? '\r\n' : '\n';
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
    assert.include(offer(['y'], true, () => fs.symlinkSync(outside, profile)), 'could not finish');
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
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', input: 'y\n', env: testChildEnvironment(env) });
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

});
