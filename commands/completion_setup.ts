const { terminalPath } = require('./terminalStyle.ts');
const fs = require('fs');
const path = require('path');
const tty = require('tty');
const { readPromptLine, parseYesNo, writeStdoutLine, rethrowInterruption } = require('./commandHelpers.ts');

class CompletionProfileError extends Error {}

type CompletionTarget = { shell: 'zsh' | 'bash'; profile: string; line: string };
type CompletionSetupOptions = {
  presentation?: 'installation' | 'standalone';
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  prompt?: (text: string) => { text: string; eof: boolean };
  write?: (text: string) => void;
};

const activationLine = (shell: 'zsh' | 'bash'): string => {
  const asset = shell === 'zsh' ? '_ballin' : 'ballin.bash';
  return `[[ -r "$HOME/.ballin-scripts/completions/${asset}" ]] && source "$HOME/.ballin-scripts/completions/${asset}"`;
};

const inspectProfile = (profile: string): void => {
  if (!fs.lstatSync(path.dirname(profile)).isDirectory()) throw new Error('Unsafe startup directory');
  try {
    if (!fs.lstatSync(profile).isFile() || fs.lstatSync(profile).nlink !== 1) throw new Error('Unsafe startup file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const completionTarget = (
  env: NodeJS.ProcessEnv,
  prompt: (text: string) => { text: string; eof: boolean },
): CompletionTarget | null => {
  const home = env.HOME;
  if (!home || !path.isAbsolute(home) || !env.SHELL || !path.isAbsolute(env.SHELL)) return null;
  const shell = path.basename(env.SHELL);
  let profile: string;
  // Quickstart may reuse a file the user explicitly selected, never edit consent.
  const selected = env.BALLIN_SETUP_PROFILE;
  const reusable = selected && path.isAbsolute(selected) && !/[\r\n\0]/u.test(selected)
    && (shell === 'zsh' ? path.basename(selected) === '.zshrc'
      : shell === 'bash' && ['.bashrc', '.bash_profile', '.bash_login', '.profile'].includes(path.basename(selected)));
  if (reusable) {
    if (shell === 'bash' && path.basename(selected) === '.profile') return null;
    profile = selected;
  } else if (shell === 'zsh') {
    const suggested = env.ZDOTDIR && path.isAbsolute(env.ZDOTDIR) && !/[\r\n\0]/u.test(env.ZDOTDIR) ? env.ZDOTDIR : home;
    const defaultLabel = suggested === home ? 'home (~), an absolute directory' : `${terminalPath(suggested, home)}, another absolute directory`;
    const choice = prompt(`Zsh settings directory [Enter for ${defaultLabel}, or skip]: `);
    if (choice.eof || choice.text === 'skip') return null;
    const directory = choice.text === '' ? suggested : choice.text === 'home' ? home : choice.text;
    if (!path.isAbsolute(directory) || /[\r\n\0]/u.test(directory)) return null;
    profile = `${directory.replace(/\/$/u, '')}/.zshrc`;
  } else if (shell === 'bash') {
    const choice = prompt('Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ');
    if (choice.eof) return null;
    if (choice.text === 'bashrc') profile = path.join(home, '.bashrc');
    else if (choice.text === 'login') {
      // Bash reads only the first existing login startup file.
      const existing = ['.bash_profile', '.bash_login', '.profile'].find((name) => {
        try { fs.lstatSync(path.join(home, name)); return true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      });
      if (existing === '.profile') return null;
      profile = path.join(home, existing ?? '.bash_profile');
    } else return null;
  } else return null;
  inspectProfile(profile);
  return { shell, profile, line: activationLine(shell) };
};

const appendActivation = (target: CompletionTarget): boolean => {
  // Recheck after confirmation, then refuse link-following at open time too.
  inspectProfile(target.profile);
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number;
  try { fd = fs.openSync(target.profile, flags); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fd = fs.openSync(target.profile, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  }
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(target.profile);
    if (!opened.isFile() || !current.isFile() || opened.nlink !== 1 || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Startup file changed');
    }
    const contents = fs.readFileSync(fd) as Buffer;
    const lines = contents.toString('utf8').split('\n');
    if (lines.includes(`${target.line}\r`)) {
      throw new CompletionProfileError(`The completion activation in ${terminalPath(target.profile)} has a trailing carriage return. Replace only that activation line manually with the command below, using LF line endings before reloading this file:\n${target.line}`);
    }
    if (lines.includes(target.line)) return false;
    const trailingBackslashes = contents.toString('utf8').match(/(\\+)(?:\r?\n)?$/u)?.[1];
    if (trailingBackslashes && trailingBackslashes.length % 2 !== 0) {
      throw new Error('Startup file ends at a continuation boundary');
    }
    const newline = '\n';
    const separator = contents.length && contents[contents.length - 1] !== 10 ? newline : '';
    const appended = Buffer.from(`${separator}${target.line}${newline}`);
    try { fs.writeFileSync(fd, appended); } catch (error) {
      try {
        // Restore the original length only when the observed bytes match this append.
        const failedSize = fs.fstatSync(fd).size;
        if (failedSize < contents.length || failedSize > contents.length + appended.length) {
          throw new Error('Startup file changed during append');
        }
        const failed = Buffer.alloc(failedSize);
        if (fs.readSync(fd, failed, 0, failedSize, 0) !== failedSize
          || !failed.subarray(0, contents.length).equals(contents)
          || !failed.subarray(contents.length).equals(appended.subarray(0, failedSize - contents.length))) {
          throw new Error('Startup file changed during append');
        }
        fs.ftruncateSync(fd, contents.length);
      } catch {
        throw new CompletionProfileError(`The completion append could not be restored. Inspect ${terminalPath(target.profile)} for incomplete activation before reloading it.`);
      }
      throw error;
    }
    return true;
  } finally { fs.closeSync(fd); }
};

const offerCompletionSetup = (docsUrl: string, options: CompletionSetupOptions = {}): void => {
  const write = options.write ?? writeStdoutLine;
  const fallback = (needsContext = false): void => {
    if (needsContext) write();
    write(`ℹ️  Tab completion skipped.\n🔗 Enable it later:\n${docsUrl}#startup-files-and-manual-activation`);
  };
  if (!(options.interactive ?? tty.isatty(0))) { fallback(true); return; }
  const prompt = options.prompt ?? readPromptLine;
  try {
    const env = options.env ?? process.env;
    let firstQuestion = true;
    const completionPrompt: typeof prompt = (question: string) => {
      if (firstQuestion && options.presentation === 'installation') write('');
      firstQuestion = false;
      return prompt(question);
    };
    const target = completionTarget(env, completionPrompt);
    if (!target) { fallback(true); return; }
    // Inspect only the selected file; a conventional location is not activation proof.
    try {
      const fd = fs.openSync(target.profile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let enabled = false;
      try {
        if (fs.fstatSync(fd).isFile()) {
          const lines = fs.readFileSync(fd, 'utf8').split('\n');
          enabled = lines.includes(target.line) && !lines.includes(`${target.line}\r`);
        }
      } finally { fs.closeSync(fd); }
      if (enabled) {
        if (options.presentation !== 'installation') write('Tab completion is already enabled.');
        return;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    while (true) {
      const answer = completionPrompt(`Enable tab completion in ${terminalPath(target.profile, env.HOME)}? [y/N] `);
      if (answer.eof) { fallback(); return; }
      const enabled = parseYesNo(answer.text, false);
      if (enabled === false) { fallback(); return; }
      if (enabled === true) break;
      write('Please enter yes or no.');
    }
    const appended = appendActivation(target);
    if (options.presentation !== 'installation') write(appended ? 'Tab completion enabled.' : 'Tab completion is already enabled.');
  } catch (error) {
    rethrowInterruption(error);
    if (error instanceof CompletionProfileError) write(error.message);
    write('Tab completion setup could not finish. Ballin remains installed.');
    write(`🔗 Manual setup:\n${docsUrl}#startup-files-and-manual-activation`);
  }
};

module.exports = { activationLine, appendActivation, completionTarget, offerCompletionSetup };
