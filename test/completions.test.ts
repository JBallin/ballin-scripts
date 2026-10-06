const { prepareMemberFixture, fixtureState, archive } = require('./helpers/completion_members.ts');
const { configCompletionNames } = require('../config/completion.ts');
const { snapshotDefinitions } = require('../commands/backup_snapshots.ts');
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
  topLevelCommandNames, commandHelpOptionName, doctorVerboseOptionName,
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

  it('never calls zsh compadd with an empty member result', function () {
    this.timeout(10000);
    const shellPath = findShell('zsh');
    for (const state of ['missing bundle', 'unknown bundle', 'unusable config']) {
      const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-empty-member-completion-')));
      try {
        const files = prepareMemberFixture(fixture);
        if (state === 'missing bundle') fs.unlinkSync(files.file);
        if (state === 'unusable config') fs.writeFileSync(files.config, '{');
        const before = fixtureState(fixture);
        const result = spawnSync(shellPath, ['-d', '-f', '-c', [
          'compdef() { :; }',
          'compadd() { printf "COMPADD:%s\\n" "$#"; printf "<%s>\\n" "$@"; }',
          'source "$COMPLETION_ASSET"',
          'CURRENT=6; words=(ballin backup read "$BUNDLE" --file "")',
          '_ballin',
        ].join('\n')], { cwd: fixture, encoding: 'utf8', timeout: 3000,
          env: fixtureEnvironment(fixture, { COMPLETION_ASSET: zshCompletionPath,
            BUNDLE: state === 'unknown bundle' ? 'unknown.bundle.json' : 'codex_skills.bundle.json',
            NODE_OPTIONS: `--require=${path.join(fixture, 'completion-guard.cjs')}` }) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '', state);
        assert.equal(result.stderr, '', state);
        assert.isFalse(fs.existsSync(path.join(fixture, 'forbidden')));
        assert.deepEqual(fixtureState(fixture), before);
      } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
    }
  });

  for (const shell of ['zsh', 'bash'] as const) {
    it(`preserves native ${shell} current-command context after harmless compound prefixes`, function () {
      this.timeout(10000);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const prefix of ['true && ', 'true; ']) {
        const result = runNativeCompletion(shell, asset, `${prefix}ballin upd\t`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(result.calls, ['update']);
      }
    });

    it(`keeps native ${shell} static candidates independent of cwd directory collisions`, function () {
      this.timeout(20000);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const [input, candidate] of [
        ['ballin upd\t', 'update'], ['ballin con\t', 'config'],
        ['ballin backup read codex_user_sk\t', 'codex_user_skills.bundle.json'],
      ]) {
        const result = runNativeCompletion(shell, asset, input, (fixture: string) => fs.mkdirSync(path.join(fixture, candidate)));
        const expected = input.slice(0, input.lastIndexOf(' ') + 1) + candidate;
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(result.calls, [expected.slice('ballin '.length)]);
      }
    });

    it(`preserves native ${shell} member prefixes containing wordbreaks`, function () {
      this.timeout(30000);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const [prefix, member] of [
        ['colon:s', 'colon:skill/SKILL.md'], ['equals=s', 'equals=skill/SKILL.md'],
        ["'colon:s", 'colon:skill/SKILL.md'], ['"equals=s', 'equals=skill/SKILL.md'],
        ['colon\\:s', 'colon:skill/SKILL.md'], ['equals\\=s', 'equals=skill/SKILL.md'],
        ["'colon:'s", 'colon:skill/SKILL.md'], ["equals'='s", 'equals=skill/SKILL.md'],
        ['glob:sk\\[\\?\\]', 'glob:sk[?]ill/SKILL.md'],
        ['colon:\\*', 'colon:*star/file.md'],
      ]) {
        const result = runNativeCompletion(shell, asset, `ballin backup read codex_skills.bundle.json --file ${prefix}\t`, (fixture: string) => {
          const files = prepareMemberFixture(fixture);
          fs.writeFileSync(files.file, archive([member]));
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(result.arguments, ['backup', 'read', 'codex_skills.bundle.json', '--file', member]);
        assert.isFalse(result.forbidden);
      }
    });

    it(`offers ${shell} values only in supported positions, with offline read-only member discovery`, function () {
      this.timeout(10000);
      const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-completion-values-')));
      const files = prepareMemberFixture(fixture);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      const forbidden = path.join(fixture, 'forbidden');
      for (const name of ['ballin', 'gh', 'git', 'curl', 'chmod', 'mkdir', 'mv', 'rm']) {
        fs.writeFileSync(path.join(fixture, name), `#!/bin/sh\nprintf forbidden >> '${forbidden}'\nexit 99\n`, { mode: 0o700 });
      }
      const script = [
        ...(shell === 'zsh' ? [
          'compdef() { :; }',
          'compadd() { shift; local candidate; for candidate in "$@"; do [[ "$candidate" == "$PREFIX"* ]] && print -r -- "$candidate"; done; return 0; }',
        ] : []),
        'source "$1"', 'shift',
        ...(shell === 'zsh' ? [
          'CURRENT="$1"; PREFIX="$2"; shift 2; words=("$@"); _ballin',
        ] : [
          'COMP_CWORD="$1"; shift 2; COMP_WORDS=("$@"); _ballin_completion; printf "%s\\n" "${COMPREPLY[@]}"',
        ]),
      ].join('\n');
      const complete = (words: string[], prefix = words.at(-1) ?? '', position = words.length - 1) => {
        const result = spawnSync(findShell(shell), [
          ...(shell === 'zsh' ? ['-d', '-f'] : ['--noprofile', '--norc']), '-c', script,
          'value-completion-test', asset, String(position + (shell === 'zsh' ? 1 : 0)), prefix, ...words,
        ], { cwd: fixture, encoding: 'utf8', timeout: 2000,
          env: fixtureEnvironment(fixture, { BALLIN_TEST_CONFIG_PATH: files.config,
            NODE_OPTIONS: `--require=${path.join(fixture, 'completion-guard.cjs')}` }) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return outputLines(result.stdout);
      };
      try {
        const before = fixtureState(fixture);
        const names = configCompletionNames();
        assert.deepEqual(complete(['ballin', 'config', 'get', '']), names.readable);
        assert.deepEqual(complete(['ballin', 'config', 'set', '']), names.leaves);
        assert.deepEqual(complete(['ballin', 'config', 'get', 'up']), names.readable.filter((name: string) => name.startsWith('up')));
        for (const key of names.booleans) {
          assert.deepEqual(complete(['ballin', 'config', 'set', key, '']), ['true', 'false']);
          assert.deepEqual(complete(['ballin', 'config', 'set', key, 'f']), ['false']);
        }
        for (const words of [
          ['ballin', 'config', 'set', 'backup.repository', ''], ['ballin', 'config', 'set', 'unknown', ''],
          ['ballin', 'config', 'set', 'update', ''], ['ballin', 'config', 'reset', ''],
          ['ballin', 'config', 'get', 'update', ''], ['ballin', 'config', 'set', 'update.cleanup', 'true', ''],
          ['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--list', ''],
          ['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--file', 'other/readme.md', ''],
          ['ballin', 'backup', 'read', 'unknown.bundle.json', '--file', ''],
        ]) assert.deepEqual(complete(words), [], words.join(' '));
        assert.deepEqual(complete(['ballin', 'backup', 'read', '']), snapshotDefinitions.map(({ name }: { name: string }) => name));
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_user_sk']), ['codex_user_skills.bundle.json']);
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--file', '']),
          ['skill with spaces/SKILL.md', "quotes'and\"marks/file.md", 'other/readme.md']);
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--file', 'skill with']),
          ['skill with spaces/SKILL.md']);
        if (shell === 'bash') {
          for (const prefix of ["'skill with", '"skill with', 'skill\\ with']) {
            assert.deepEqual(complete(['ballin', 'backup', 'read', '"codex_skills.bundle.json"', '--file', prefix]), ['skill with spaces/SKILL.md']);
          }
        }
        assert.deepEqual(fixtureState(fixture), before);
        fs.unlinkSync(files.file);
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--file', '']), []);
        fs.unlinkSync(path.join(fixture, 'node'));
        fs.writeFileSync(files.config, 'unusable saved config');
        const unavailable = fixtureState(fixture);
        assert.deepEqual(complete(['ballin', 'config', 'get', '']), names.readable);
        assert.deepEqual(complete(['ballin', 'config', 'set', 'update.cleanup', 'f']), ['false']);
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_user_sk']), ['codex_user_skills.bundle.json']);
        assert.deepEqual(complete(['ballin', 'backup', 'read', 'codex_skills.bundle.json', '--file', '']), []);
        assert.deepEqual(fixtureState(fixture), unavailable);
        assert.isFalse(fs.existsSync(forbidden));
      } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
    });

    it(`preserves spaces and quoting with native ${shell} member completion`, function () {
      this.timeout(30000);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const prefix of ['skill', "'skill with", '"skill with', 'skill\\ with', 'skill" with', 'quotes', "'quotes"]) {
        const member = prefix.includes('quotes') ? "quotes'and\"marks/file.md" : 'skill with spaces/SKILL.md';
        const expected = `ballin backup read codex_skills.bundle.json --file ${member}`;
        const result = runNativeCompletion(shell, asset, `ballin backup read codex_skills.bundle.json --file ${prefix}\t`, prepareMemberFixture);
        assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr} ${result.stdout}`);
        assert.include(result.stdout, `INSERTED:${result.marker}:${expected}`);
        assert.deepEqual(result.calls, [expected.slice('ballin '.length)]);
        assert.deepEqual(result.arguments, ['backup', 'read', 'codex_skills.bundle.json', '--file', member]);
        assert.isFalse(result.forbidden);
      }
    });

    it(`preserves native ${shell} quote context at the replacement boundary`, function () {
      this.timeout(10000);
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const [prefix, member] of [[`"quotes'an`, `quotes'and"marks/file.md`], [String.raw`'back\sl`, String.raw`back\slash/file.md`]]) {
        const result = runNativeCompletion(shell, asset, `ballin backup read codex_skills.bundle.json --file ${prefix}\t`, (fixture: string) => {
          const files = prepareMemberFixture(fixture);
          fs.writeFileSync(files.file, archive([member]));
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(result.arguments, ['backup', 'read', 'codex_skills.bundle.json', '--file', member]);
        assert.isFalse(result.forbidden);
      }
    });

    it(`inserts shell metacharacters literally with native ${shell} completion`, function () {
      this.timeout(10000);
      const member = 'literal$(touch forbidden)/file.md';
      const asset = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      const result = runNativeCompletion(shell, asset, 'ballin backup read codex_skills.bundle.json --file literal\t', (fixture: string) => {
        const files = prepareMemberFixture(fixture);
        fs.writeFileSync(files.file, archive([member]));
      });
      assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr} ${result.stdout}`);
      assert.deepEqual(result.calls, [`backup read codex_skills.bundle.json --file ${member}`]);
      assert.deepEqual(result.arguments, ['backup', 'read', 'codex_skills.bundle.json', '--file', member]);
      assert.isFalse(result.forbidden);
    });

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
          'CURRENT="$2"', 'PREFIX="$3"', 'words=(ballin "$4" "$3" extra)',
          'if [[ "$CURRENT" -eq 5 ]]; then words=(ballin "$4" read snapshot "$3"); fi', '_ballin',
        ] : [
          'COMP_CWORD="$2"', 'COMP_WORDS=(ballin "$4" "$3" extra)',
          'if [[ "$COMP_CWORD" -eq 1 ]]; then COMP_WORDS=(ballin "$3"); fi',
          'if [[ "$COMP_CWORD" -eq 4 ]]; then COMP_WORDS=(ballin "$4" read snapshot "$3"); fi',
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
          [1, '', '', [...topLevelCommandNames, commandHelpOptionName]], [1, 'upd', '', ['update']],
          [1, 'u', '', ['uninstall', 'update']], [1, 'missing', '', []],
          [2, '', 'backup', [...backupCommandNames, commandHelpOptionName]], [2, 'op', 'backup', ['open']],
          [2, 's', 'backup', ['setup']], [2, 'r', 'backup', ['read']],
          [2, 'd', 'backup', ['disconnect']], [2, 'l', 'backup', ['list']],
          [2, '', 'config', [...configOperationNames, commandHelpOptionName]], [2, 'g', 'config', ['get']],
          [2, 's', 'config', ['set']], [2, 'r', 'config', ['reset']],
          [2, 'help', 'config', []], [2, '--', 'config', [commandHelpOptionName]],
          [2, 'help', 'backup', []], [2, '--', 'backup', [commandHelpOptionName]],
          [2, 'missing', 'backup', []], [2, '', 'unknown', []],
          [3, '', 'backup', []], [3, '', 'config', []], [4, '', 'config', []],
          [4, '', 'backup', ['--list', '--file']], [4, '--f', 'backup', ['--file']],
        ];
        for (const family of topLevelCommandNames.filter((name: string) => !['backup', 'config'].includes(name))) {
          cases.push([2, '', family, [...(family === 'doctor' ? [doctorVerboseOptionName] : []), commandHelpOptionName]]);
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
      this.timeout(60000);
      const assetPath = shell === 'zsh' ? zshCompletionPath : bashCompletionPath;
      for (const [input, expected] of [
        ['ballin upd\t', 'ballin update'],
        ['ballin --h\t', 'ballin --help'],
        ['ballin update --h\t', 'ballin update --help'],
        ['ballin doctor --v\t', 'ballin doctor --verbose'],
        ['ballin backup op\t', 'ballin backup open'],
        ['ballin config ge\t', 'ballin config get'],
        ['ballin config get update.cl\t', 'ballin config get update.cleanup'],
        ['ballin config set update.cleanup f\t', 'ballin config set update.cleanup false'],
        ['ballin backup read codex_user_sk\t', 'ballin backup read codex_user_skills.bundle.json'],
        ['ballin backup missing\t', 'ballin backup missing'],
        ['ballin config help\t', 'ballin config help'],
        ['ballin backup read missing\t', 'ballin backup read missing'],
        ['ballin backup read snapshot --f\t', 'ballin backup read snapshot --file'],
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
