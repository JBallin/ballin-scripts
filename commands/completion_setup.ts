const fs = require('fs');
const path = require('path');
const { readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');

class CompletionProfileError extends Error {}

type CompletionTarget = { shell: 'zsh' | 'bash'; profile: string; line: string };
type CompletionSetupOptions = {
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
    if (!fs.lstatSync(profile).isFile()) throw new Error('Unsafe startup file');
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
  if (shell === 'zsh') {
    const hint = env.ZDOTDIR ? ` Exported ZDOTDIR: ${env.ZDOTDIR}.` : '';
    const choice = prompt(`Which directory contains the .zshrc your terminal reads?${hint} [home or absolute directory; Enter to skip] `);
    if (choice.eof) return null;
    const directory = choice.text === 'home' ? home : choice.text;
    if (!path.isAbsolute(directory)) return null;
    profile = path.join(directory, '.zshrc');
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
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Startup file changed');
    }
    const contents = fs.readFileSync(fd) as Buffer;
    const lines = contents.toString('utf8').split('\n');
    if (lines.includes(`${target.line}\r`)) {
      throw new CompletionProfileError(`The completion activation in ${target.profile} has a trailing carriage return. Replace only that activation line manually with the displayed command using LF before reloading this file.`);
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
        throw new CompletionProfileError(`The completion append could not be restored. Inspect ${target.profile} for incomplete activation before reloading it.`);
      }
      throw error;
    }
    return true;
  } finally { fs.closeSync(fd); }
};

const offerCompletionSetup = (docsUrl: string, options: CompletionSetupOptions = {}): void => {
  const write = options.write ?? writeStdoutLine;
  const fallback = (needsContext = false): void => {
    if (needsContext) write('\nEnable shell completion later:');
    write(`${docsUrl}#shell-completion`);
  };
  if (!(options.interactive ?? process.stdin.isTTY)) { fallback(true); return; }
  const prompt = options.prompt ?? readPromptLine;
  try {
    const target = completionTarget(options.env ?? process.env, prompt);
    if (!target) { fallback(true); return; }
    write(`\nShell completion for ${target.shell}: append to ${target.profile}`);
    write(target.line);
    const answer = prompt('Enable shell completion? [y/N] ');
    if (answer.eof || !['y', 'Y'].includes(answer.text)) { fallback(); return; }
    const appended = appendActivation(target);
    write(appended ? 'Shell completion enabled. Open a new terminal or reload this startup file.'
      : 'Shell completion is already enabled. Open a new terminal or reload this startup file.');
  } catch (error) {
    if (error instanceof CompletionProfileError) write(error.message);
    write('Shell completion setup could not finish. Ballin remains installed.');
    fallback();
  }
};

module.exports = { activationLine, appendActivation, completionTarget, offerCompletionSetup };
