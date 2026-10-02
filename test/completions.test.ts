const { spawnSync } = require('child_process');
const { findShell, fixtureEnvironment, runNativeCompletion } = require('./helpers/shell_completion.ts');
const { backupCommandNames, isBackupCommandName } = require('../commands/backup_commands.ts');
const { configOperationNames, isConfigOperationName } = require('../config/commands.ts');
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

  it('recognizes only public operation names', () => {
    for (const [names, recognizes] of [
      [backupCommandNames, isBackupCommandName],
      [configOperationNames, isConfigOperationName],
    ] as const) {
      names.forEach((name: string) => assert.isTrue(recognizes(name)));
      [undefined, null, 42, {}, '', 'help', '--help', 'typo'].forEach((name) => {
        assert.isFalse(recognizes(name));
      });
    }
  });

  for (const shell of ['zsh', 'bash'] as const) {
    it(`offers ${shell} public nested candidates without running commands or reading state`, () => {
      const shellPath = findShell(shell);
      const assetPath = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-completion-state-')));
      const configPath = path.join(fixture, 'ballin.config.json');
      const statePath = path.join(fixture, '.backup-cache');
      fs.writeFileSync(configPath, 'unreadable config is irrelevant to completion');
      fs.mkdirSync(statePath);
      fs.writeFileSync(path.join(statePath, 'state'), 'unchanged');
      const forbiddenLog = path.join(fixture, 'commands');
      const script = [
        'for name in ballin gh git node curl; do',
        '  eval "$name() { printf forbidden >> \"$FORBIDDEN_LOG\"; return 99; }"',
        'done',
        ...(shell === 'zsh' ? [
          'compdef() { :; }',
          'compadd() {',
          '  local candidate',
          '  for candidate in "$@"; do',
          '    [[ "$candidate" == -- ]] && continue',
          '    [[ "$candidate" == "$PREFIX"* ]] && print -r -- "$candidate"',
          '  done',
          '  return 0',
          '}',
        ] : []),
        'source "$1"',
        ...(shell === 'zsh' ? [
          'CURRENT="$2"', 'PREFIX="$3"', 'words=(ballin "$4" "$3" extra)', '_ballin',
        ] : [
          'COMP_CWORD="$2"', 'COMP_WORDS=(ballin "$4" "$3" extra)',
          'if [[ "$COMP_CWORD" -eq 1 ]]; then COMP_WORDS=(ballin "$3"); fi',
          'COMPREPLY=(stale)', '_ballin_completion',
          'printf "%s\\n" "${COMPREPLY[@]}"',
        ]),
      ].join('\n');
      const complete = (position: number, prefix: string, family = '') => spawnSync(shellPath, [
        ...(shell === 'zsh' ? ['-d', '-f'] : ['--noprofile', '--norc']),
        '-c', script, 'ballin-completion-test', assetPath,
        String(position + (shell === 'zsh' ? 1 : 0)), prefix, family,
      ], {
        cwd: fixture, encoding: 'utf8', timeout: 2000,
        env: fixtureEnvironment(fixture, { FORBIDDEN_LOG: forbiddenLog, BALLIN_TEST_CONFIG_PATH: configPath }),
      });
      try {
        const syntax = spawnSync(shellPath, [...(shell === 'zsh' ? ['-d', '-f'] : ['--noprofile', '--norc']), '-n', assetPath], {
          cwd: fixture, encoding: 'utf8', timeout: 2000, env: fixtureEnvironment(fixture),
        });
        assert.equal(syntax.status, 0, syntax.stderr);
        const cases: [number, string, string, readonly string[]][] = [
          [1, '', '', topLevelCommandNames], [1, 'upd', '', ['update']],
          [1, 'u', '', ['uninstall', 'update']], [1, 'missing', '', []],
          [2, '', 'backup', backupCommandNames], [2, 'op', 'backup', ['open']],
          [2, 's', 'backup', ['setup']], [2, 'r', 'backup', ['read']],
          [2, 'd', 'backup', ['disconnect']],
          [2, '', 'config', configOperationNames], [2, 'g', 'config', ['get']],
          [2, 's', 'config', ['set']], [2, 'r', 'config', ['reset']],
          [2, 'help', 'config', []], [2, '--', 'config', []],
          [2, 'help', 'backup', []], [2, '--', 'backup', []],
          [2, 'missing', 'backup', []], [2, '', 'unknown', []],
          [3, '', 'backup', []], [3, '', 'config', []], [4, '', 'config', []],
        ];
        for (const family of topLevelCommandNames.filter((name: string) => !['backup', 'config'].includes(name))) {
          cases.push([2, '', family, []]);
        }
        for (const [position, prefix, family, expected] of cases) {
          const result = complete(position, prefix, family);
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(outputLines(result.stdout), [...expected], `${family} ${prefix} at ${position}`);
        }
        assert.isFalse(fs.existsSync(forbiddenLog));
        assert.equal(fs.readFileSync(configPath, 'utf8'), 'unreadable config is irrelevant to completion');
        assert.deepEqual(fs.readdirSync(statePath), ['state']);
        assert.equal(fs.readFileSync(path.join(statePath, 'state'), 'utf8'), 'unchanged');
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it(`inserts unique prefixes with native ${shell} Tab completion`, function () {
      this.timeout(20000);
      const assetPath = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const [input, expected] of [
        ['ballin upd\t', 'ballin update'],
        ['ballin backup op\t', 'ballin backup open'],
        ['ballin config ge\t', 'ballin config get'],
        ['ballin backup missing\t', 'ballin backup missing'],
        ['ballin config help\t', 'ballin config help'],
        ['ballin backup read missing\t', 'ballin backup read missing'],
      ]) {
        const result = runNativeCompletion(shell, assetPath, input);
        assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr} ${result.stdout}`);
        assert.include(result.stdout, `READY:${result.marker}`);
        assert.include(result.stdout, `INSERTED:${result.marker}:${expected}`);
        assert.include(result.stdout, `CHILD_EXIT:${result.marker}:0`);
        assert.include(result.stdout, `CLEANED:${result.marker}`);
        assert.deepEqual(result.calls, [expected.slice('ballin '.length)]);
      }
    });
  }
});
