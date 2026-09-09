const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  backupMarkerFileName,
  classifySnapshotFileName,
  collectSnapshotObservations,
  configSnapshotFileName,
  normalizeSnapshotInput,
  observeSnapshotSources,
  snapshotDefinitions,
} = require('../commands/backup_snapshots.ts');

import type {
  AvailableSnapshotObservation,
  SnapshotDefinition,
  SnapshotSourceObservation,
} from '../commands/backup_snapshots.ts';

const expectedDefinitions = [
  ['bash_profile.sh', 'shell', [{ kind: 'file', name: '.bash_profile' }]],
  ['bashrc.sh', 'shell', [{ kind: 'file', name: '.bashrc' }]],
  ['profile.sh', 'shell', [{ kind: 'file', name: '.profile' }]],
  ['zprofile.sh', 'shell', [{ kind: 'file', name: '.zprofile' }]],
  ['zshrc.sh', 'shell', [{ kind: 'file', name: '.zshrc' }]],
  [
    'bash_completions',
    'bash-completions',
    [{ kind: 'directory', name: 'active Homebrew bash completion directory' }],
  ],
  ['brew_list', 'homebrew', [{ kind: 'tool', name: 'brew' }]],
  ['brew_leaves', 'homebrew', [{ kind: 'tool', name: 'brew' }]],
  ['brew_cask', 'homebrew', [{ kind: 'tool', name: 'brew' }]],
  ['brew_services', 'homebrew', [{ kind: 'tool', name: 'brew' }]],
  ['Brewfile', 'homebrew', [{ kind: 'tool', name: 'brew' }]],
  ['gitignore_global', 'git', [{ kind: 'file', name: '.gitignore_global' }]],
  ['gitconfig', 'git', [{ kind: 'file', name: '.gitconfig' }]],
  ['npm_global', 'npm', [{ kind: 'tool', name: 'npm' }]],
  ['pipx', 'python', [{ kind: 'tool', name: 'pipx' }]],
  ['uv_tools', 'python', [{ kind: 'tool', name: 'uv' }]],
  ['pyenv_versions', 'python', [{ kind: 'tool', name: 'pyenv' }]],
  ['nvmrc', 'node', [{ kind: 'file', name: '.nvmrc' }]],
  [
    'vs_settings',
    'vscode',
    [{ kind: 'application', name: 'Code' }, { kind: 'file', name: 'settings.json' }],
  ],
  [
    'vs_keybindings',
    'vscode',
    [{ kind: 'application', name: 'Code' }, { kind: 'file', name: 'keybindings.json' }],
  ],
  [
    'vs_extensions',
    'vscode',
    [{ kind: 'application', name: 'Code' }, { kind: 'tool', name: 'code' }],
  ],
  [
    'vsI_settings',
    'vscode-insiders',
    [{ kind: 'application', name: 'Code - Insiders' }, { kind: 'file', name: 'settings.json' }],
  ],
  [
    'vsI_keybindings',
    'vscode-insiders',
    [{ kind: 'application', name: 'Code - Insiders' }, { kind: 'file', name: 'keybindings.json' }],
  ],
  [
    'vsI_extensions',
    'vscode-insiders',
    [{ kind: 'application', name: 'Code - Insiders' }, { kind: 'tool', name: 'code-insiders' }],
  ],
  ['vimrc', 'editor', [{ kind: 'file', name: '.vimrc' }]],
  ['nanorc', 'editor', [{ kind: 'file', name: '.nanorc' }]],
  [
    'ballin_config',
    'ballin',
    [{ kind: 'file', name: path.join('.ballin-scripts', 'ballin.config.json') }],
  ],
  ['mas', 'mas', [{ kind: 'tool', name: 'mas' }]],
];

describe('backup snapshot definitions', () => {
  let homeDir: string;

  const observations = (env: NodeJS.ProcessEnv = { PATH: '' }): SnapshotSourceObservation[] => (
    observeSnapshotSources({ homeDir, env })
  );

  const observation = (
    name: string,
    env: NodeJS.ProcessEnv = { PATH: '' },
  ): SnapshotSourceObservation => {
    const result = observations(env).find(({ definition }) => definition.name === name);
    assert.exists(result);
    return result as SnapshotSourceObservation;
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-snapshot-definitions-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('provides one unique ordered definition with explicit prerequisites for every current snapshot', () => {
    assert.deepEqual(
      snapshotDefinitions.map(({ name, category, prerequisites }: SnapshotDefinition) => (
        [name, category, prerequisites]
      )),
      expectedDefinitions,
    );
    assert.equal(new Set(snapshotDefinitions.map(({ name }: SnapshotDefinition) => name)).size, 28);

    assert.equal(configSnapshotFileName, 'ballin_config');
    assert.equal(backupMarkerFileName, '.MyConfig.md');
  });

  it('classifies only exact current, retired, and reserved names', () => {
    expectedDefinitions.forEach(([name]) => assert.equal(classifySnapshotFileName(name), 'current'));
    [
      'brackets_disabled_extensions',
      'brackets_extensions',
      'brackets_keymap.json',
      'brackets_settings.json',
    ].forEach((name) => assert.equal(classifySnapshotFileName(name), 'retired'));
    assert.equal(classifySnapshotFileName('.MyConfig.md'), 'reserved');

    [
      'Gitconfig',
      'gitconfig.bak',
      'archive/gitconfig',
      'brackets_extensions.bak',
      'Brackets_settings.json',
      '.MyConfig.md.bak',
      'unexpected',
    ].forEach((name) => assert.equal(classifySnapshotFileName(name), 'unexpected'));
  });

  it('returns one ordered observation even when every local source is absent or unavailable', () => {
    const result = observations();

    assert.lengthOf(result, 28);
    assert.deepEqual(result.map(({ definition }) => definition.name), expectedDefinitions.map(([name]) => name));
    assert.equal(observation('zshrc.sh').status, 'absent');
    assert.equal(observation('brew_list').status, 'unavailable');
    assert.equal(observation('vs_settings').status, 'unavailable');
  });

  it('distinguishes available files, confirmed absence, wrong types, and failed access probes', () => {
    fs.writeFileSync(path.join(homeDir, '.zshrc'), 'export EDITOR=vim\n');
    fs.mkdirSync(path.join(homeDir, '.bashrc'));
    fs.symlinkSync('.profile', path.join(homeDir, '.profile'));

    const available = observation('zshrc.sh');
    assert.equal(available.status, 'available');
    if (available.status === 'available') {
      assert.equal(available.source.path, path.join(homeDir, '.zshrc'));
      assert.equal(available.collector.cwd, homeDir);
      assert.deepEqual(available.collector.args, ['.zshrc']);
    }

    const absent = observation('bash_profile.sh');
    assert.equal(absent.status, 'absent');
    if (absent.status === 'absent') {
      assert.equal(absent.reason, 'source-not-found');
    }

    const wrongType = observation('bashrc.sh');
    assert.equal(wrongType.status, 'unavailable');
    if (wrongType.status === 'unavailable') {
      assert.equal(wrongType.reason, 'unsupported-source-type');
    }

    const failed = observation('profile.sh');
    assert.equal(failed.status, 'discovery-failed');
    if (failed.status === 'discovery-failed') {
      assert.equal(failed.reason, 'source-access-failed');
      assert.equal((failed.error as NodeJS.ErrnoException).code, 'ELOOP');
    }
  });

  it('distinguishes unavailable tools from failed tool discovery', () => {
    const binDir = path.join(homeDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\n', { mode: 0o644 });

    const unavailable = observation('npm_global', { PATH: binDir });
    assert.equal(unavailable.status, 'unavailable');
    if (unavailable.status === 'unavailable') {
      assert.equal(unavailable.reason, 'tool-unavailable');
    }

    const loopDir = path.join(homeDir, 'loop');
    fs.symlinkSync('loop', loopDir);
    const failed = observation('pipx', { PATH: loopDir });
    assert.equal(failed.status, 'discovery-failed');
    if (failed.status === 'discovery-failed') {
      assert.equal(failed.reason, 'tool-discovery-failed');
      assert.equal((failed.error as NodeJS.ErrnoException).code, 'ELOOP');
    }
  });

  it('reports unexpected executable access failures as tool discovery failures', () => {
    const binDir = path.join(homeDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    const originalAccess = fs.accessSync;
    fs.accessSync = () => {
      throw new Error('simulated executable access failure');
    };

    try {
      const failed = observation('npm_global', { PATH: binDir });
      assert.equal(failed.status, 'discovery-failed');
      if (failed.status === 'discovery-failed') {
        assert.equal(failed.reason, 'tool-discovery-failed');
        assert.equal(failed.error?.message, 'simulated executable access failure');
      }
    } finally {
      fs.accessSync = originalAccess;
    }
  });

  it('reports partial editor availability per snapshot and retains the resolved roots', () => {
    const editorDir = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
    fs.mkdirSync(editorDir, { recursive: true });
    fs.writeFileSync(path.join(editorDir, 'settings.json'), '{}\n');

    const settings = observation('vs_settings');
    const keybindings = observation('vs_keybindings');
    const extensions = observation('vs_extensions');

    assert.equal(settings.status, 'available');
    if (settings.status === 'available') {
      assert.equal(settings.source.root, editorDir);
    }
    assert.equal(keybindings.status, 'absent');
    assert.equal(extensions.status, 'unavailable');
    if (extensions.status === 'unavailable') {
      assert.equal(extensions.reason, 'tool-unavailable');
      assert.equal(extensions.source.root, editorDir);
    }
    assert.equal(observation('vsI_settings').status, 'unavailable');
  });

  it('distinguishes unsupported and failed editor-root discovery for every editor snapshot', () => {
    const applicationDir = path.join(homeDir, 'Library', 'Application Support', 'Code');
    const editorDir = path.join(applicationDir, 'User');
    fs.mkdirSync(applicationDir, { recursive: true });
    fs.writeFileSync(editorDir, 'not a directory\n');

    ['vs_settings', 'vs_extensions'].forEach((name) => {
      const unsupported = observation(name);
      assert.equal(unsupported.status, 'unavailable');
      if (unsupported.status === 'unavailable') {
        assert.equal(unsupported.reason, 'unsupported-source-type');
      }
    });

    fs.rmSync(editorDir);
    fs.symlinkSync('User', editorDir);
    ['vs_settings', 'vs_extensions'].forEach((name) => {
      const failed = observation(name);
      assert.equal(failed.status, 'discovery-failed');
      if (failed.status === 'discovery-failed') {
        assert.equal(failed.reason, 'source-access-failed');
        assert.equal((failed.error as NodeJS.ErrnoException).code, 'ELOOP');
      }
    });
  });

  it('reports editor tool discovery failures independently of an available application', () => {
    const editorDir = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
    fs.mkdirSync(editorDir, { recursive: true });
    const loopDir = path.join(homeDir, 'loop');
    fs.symlinkSync('loop', loopDir);

    const failed = observation('vs_extensions', { PATH: loopDir });

    assert.equal(failed.status, 'discovery-failed');
    if (failed.status === 'discovery-failed') {
      assert.equal(failed.reason, 'tool-discovery-failed');
      assert.equal(failed.source.root, editorDir);
    }
  });

  it('uses a completion override without brew and isolates failed prefix discovery from brew inventories', () => {
    const completionDir = path.join(homeDir, 'completions');
    fs.mkdirSync(completionDir);

    const override = observation('bash_completions', {
      PATH: '',
      BALLIN_BACKUP_BASH_COMPLETION_DIR: completionDir,
    });
    assert.equal(override.status, 'available');
    if (override.status === 'available') {
      assert.equal(override.source.path, completionDir);
      assert.deepEqual(override.collector.args, [completionDir]);
    }

    const binDir = path.join(homeDir, 'bin');
    fs.mkdirSync(binDir);
    const brewPath = path.join(binDir, 'brew');
    fs.writeFileSync(brewPath, '#!/bin/sh\nexit 32\n', { mode: 0o755 });
    const env = { PATH: binDir };
    const completionFailure = observation('bash_completions', env);
    assert.equal(completionFailure.status, 'discovery-failed');
    if (completionFailure.status === 'discovery-failed') {
      assert.equal(completionFailure.reason, 'prerequisite-command-failed');
      assert.equal(completionFailure.exitStatus, 32);
    }

    ['brew_list', 'brew_leaves', 'brew_cask', 'brew_services', 'Brewfile'].forEach((name) => {
      const brewObservation = observation(name, env);
      assert.equal(brewObservation.status, 'available');
      if (brewObservation.status === 'available') {
        assert.equal(brewObservation.source.path, brewPath);
      }
    });
  });

  it('keeps missing, unsupported, and failed completion directories distinct', () => {
    const missing = path.join(homeDir, 'missing-completions');
    assert.equal(observation('bash_completions', {
      PATH: '',
      BALLIN_BACKUP_BASH_COMPLETION_DIR: missing,
    }).status, 'absent');

    const unsupported = path.join(homeDir, 'completion-file');
    fs.writeFileSync(unsupported, 'not a directory\n');
    const unsupportedObservation = observation('bash_completions', {
      PATH: '',
      BALLIN_BACKUP_BASH_COMPLETION_DIR: unsupported,
    });
    assert.equal(unsupportedObservation.status, 'unavailable');
    if (unsupportedObservation.status === 'unavailable') {
      assert.equal(unsupportedObservation.reason, 'unsupported-source-type');
    }

    const failedPath = path.join(homeDir, 'completion-loop');
    fs.symlinkSync('completion-loop', failedPath);
    const failed = observation('bash_completions', {
      PATH: '',
      BALLIN_BACKUP_BASH_COMPLETION_DIR: failedPath,
    });
    assert.equal(failed.status, 'discovery-failed');
    if (failed.status === 'discovery-failed') {
      assert.equal(failed.reason, 'source-access-failed');
    }
  });

  it('returns captured, reasoned skipped, and collector-failed facts while continuing in order', () => {
    fs.writeFileSync(path.join(homeDir, '.bash_profile'), 'profile\n');
    fs.writeFileSync(path.join(homeDir, '.profile'), 'profile\n');
    const selected = observations().slice(0, 3);
    const attempts: string[] = [];

    const collection = collectSnapshotObservations(
      selected,
      (source: AvailableSnapshotObservation) => {
        attempts.push(source.definition.name);
        return source.definition.name === 'profile.sh'
          ? { status: 'collector-failed' }
          : { status: 'captured', localFile: `/tmp/${source.definition.name}` };
      },
    );

    assert.deepEqual(attempts, ['bash_profile.sh', 'profile.sh']);
    assert.deepEqual(collection.map(({ status }: { status: string }) => status), [
      'captured',
      'skipped',
      'collector-failed',
    ]);
    assert.equal(collection[1].reason, 'source-not-found');
  });

  it('normalizes empty and unterminated captures without changing complete content', () => {
    const emptyFile = path.join(homeDir, 'empty');
    const unterminatedFile = path.join(homeDir, 'unterminated');
    const completeFile = path.join(homeDir, 'complete');
    fs.writeFileSync(emptyFile, '');
    fs.writeFileSync(unterminatedFile, 'value');
    fs.writeFileSync(completeFile, 'value\n\n');

    [emptyFile, unterminatedFile, completeFile].forEach(normalizeSnapshotInput);

    assert.equal(fs.readFileSync(emptyFile, 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(unterminatedFile, 'utf8'), 'value\n');
    assert.equal(fs.readFileSync(completeFile, 'utf8'), 'value\n\n');
  });
});
