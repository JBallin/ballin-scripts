const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  renderBashCompletion,
  renderZshCompletion,
  writeCompletionAssets,
} = require('../commands/completions.ts');
const {
  topLevelCommandNames,
} = require('../commands/top_level_commands.ts');

const repoRoot = path.join(__dirname, '..');
const zshCompletionPath = path.join(repoRoot, 'completions', '_ballin');
const bashCompletionPath = path.join(repoRoot, 'completions', 'ballin.bash');

const findCommand = (name: string): string => {
  const commandPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate));
  assert.exists(commandPath, `${name} is required to test shell completions`);
  return commandPath as string;
};

const outputLines = (stdout: string): string[] => stdout.trimEnd().split('\n').filter(Boolean);

describe('shell completions', () => {
  it('keeps checked-in completion assets equal to generated output', () => {
    assert.equal(fs.readFileSync(zshCompletionPath, 'utf8'), renderZshCompletion());
    assert.equal(fs.readFileSync(bashCompletionPath, 'utf8'), renderBashCompletion());

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-completions-'));
    try {
      writeCompletionAssets(outputDir);
      assert.equal(fs.readFileSync(path.join(outputDir, '_ballin'), 'utf8'), renderZshCompletion());
      assert.equal(fs.readFileSync(path.join(outputDir, 'ballin.bash'), 'utf8'), renderBashCompletion());
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps the README top-level command table aligned with the command catalog', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const documentedCommands = [...readme.matchAll(/\| `ballin ([^`]+)` \|/gu)]
      .map((match) => match[1])
      .filter((command) => !command.includes(' '));

    assert.sameMembers(documentedCommands, [...topLevelCommandNames]);
  });

  it('offers zsh top-level and unique-prefix candidates but no nested candidates', () => {
    const zshPath = findCommand('zsh');
    const completionScript = [
      'compdef() { :; }',
      'compadd() {',
      '  local candidate',
      '  for candidate in "$@"; do',
      '    [[ "$candidate" == -- ]] && continue',
      '    [[ "$candidate" == "$PREFIX"* ]] && print -r -- "$candidate"',
      '  done',
      '}',
      'source "$1"',
      'CURRENT="$2"',
      'PREFIX="$3"',
      '_ballin',
    ].join('\n');
    const complete = (current: number, prefix: string) => spawnSync(zshPath, [
      '-f', '-c', completionScript, 'ballin-completion-test', zshCompletionPath, String(current), prefix,
    ], { encoding: 'utf8' });

    const syntax = spawnSync(zshPath, ['-n', zshCompletionPath], { encoding: 'utf8' });
    const topLevel = complete(2, '');
    const uniquePrefix = complete(2, 'upd');
    const nested = complete(3, 'op');

    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(topLevel.status, 0, topLevel.stderr);
    assert.deepEqual(outputLines(topLevel.stdout), [...topLevelCommandNames]);
    assert.equal(uniquePrefix.status, 0, uniquePrefix.stderr);
    assert.deepEqual(outputLines(uniquePrefix.stdout), ['update']);
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(outputLines(nested.stdout), []);
  });

  it('offers Bash top-level and unique-prefix candidates but no nested candidates', () => {
    const bashPath = findCommand('bash');
    const completionScript = [
      'source "$1"',
      'COMP_CWORD="$2"',
      'if [[ "$COMP_CWORD" -eq 1 ]]; then',
      '  COMP_WORDS=(ballin "$3")',
      'else',
      '  COMP_WORDS=(ballin backup "$3")',
      'fi',
      '_ballin_completion',
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join('\n');
    const complete = (current: number, prefix: string) => spawnSync(bashPath, [
      '--noprofile', '--norc', '-c', completionScript,
      'ballin-completion-test', bashCompletionPath, String(current), prefix,
    ], { encoding: 'utf8' });

    const syntax = spawnSync(bashPath, ['-n', bashCompletionPath], { encoding: 'utf8' });
    const topLevel = complete(1, '');
    const uniquePrefix = complete(1, 'upd');
    const nested = complete(2, 'op');

    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(topLevel.status, 0, topLevel.stderr);
    assert.deepEqual(outputLines(topLevel.stdout), [...topLevelCommandNames]);
    assert.equal(uniquePrefix.status, 0, uniquePrefix.stderr);
    assert.deepEqual(outputLines(uniquePrefix.stdout), ['update']);
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(outputLines(nested.stdout), []);
  });
});
