const fs = require('fs');
const os = require('os');
const path = require('path');
const { reviewBackupInclusion } = require('../commands/backup_policy.ts');
const { snapshotDefinitions } = require('../commands/backup_snapshots.ts');

import type { InclusionProposals } from '../config/portable.ts';
import type { BackupInclusionReviewResult } from '../commands/backup_policy.ts';
import type { SnapshotDefinition } from '../commands/backup_snapshots.ts';

describe('backup inclusion review', () => {
  let fixtureRoot: string;
  let homeDir: string;

  const review = ({
    localConfig = {},
    proposals,
    responses = [],
  }: {
    localConfig?: unknown;
    proposals?: InclusionProposals;
    responses?: (string | null)[];
  } = {}) => {
    const prompts: string[] = [];
    const lines: string[] = [];
    const answers = [...responses];
    const before = JSON.stringify(localConfig);
    const filesBefore = fs.readdirSync(fixtureRoot, { recursive: true });
    const result = reviewBackupInclusion({
      localConfig,
      proposals,
      context: { homeDir, env: { HOME: homeDir, PATH: '' } },
      readPrompt: (prompt: string) => {
        prompts.push(prompt);
        return answers.shift() ?? null;
      },
      writeLine: (line: string) => lines.push(line),
    }) as BackupInclusionReviewResult;
    assert.equal(JSON.stringify(localConfig), before, 'Review must not mutate local config');
    assert.deepEqual(fs.readdirSync(fixtureRoot, { recursive: true }), filesBefore, 'Review must not write files');
    return { result, prompts, output: lines.join('\n') };
  };

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-policy-review-'));
    homeDir = path.join(fixtureRoot, 'home');
    fs.mkdirSync(homeDir);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('keeps optional groups off by default and requires a final affirmative confirmation', () => {
    const { result, prompts, output } = review({ responses: ['', '', 'yes'] });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: false, includeDetailed: false } });
    assert.lengthOf(prompts, 3);
    assert.isTrue(prompts.every((prompt) => prompt.endsWith('[y/N]: ')));
    assert.include(output, 'Inventory included by default: bash_completions, brew_list, brew_leaves, brew_cask, vs_extensions, vsI_extensions, mas.');
    assert.include(output, 'Detailed inventories: brew_services, Brewfile, npm_global, pipx, uv_tools, pyenv_versions.');
    assert.include(output, 'Portable Ballin preferences');
    assert.include(output, 'organizational preferences');
    assert.include(output, 'not guaranteed secret-free');
    assert.include(output, 'subsequent captures as files and symlink targets change');
    assert.include(output, 'does not scan or redact');
    assert.include(output, 'a secret Gist is unlisted, not private');
    assert.notInclude(output, 'Review selected raw sources');
  });

  it('preserves deliberate local defaults on reconnection without letting restored proposals override them', () => {
    const { result, prompts, output } = review({
      localConfig: { backup: { includeRaw: 'true', includeDetailed: 'false' }, custom: { keep: 1 } },
      proposals: { includeRaw: false, includeDetailed: true },
      responses: ['', '', 'Y'],
    });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: true, includeDetailed: false } });
    assert.include(prompts[0], '[Y/n]');
    assert.include(prompts[1], '[y/N]');
    assert.include(prompts[2], '[y/N]');
    assert.include(output, 'Restored raw configuration preference: exclude.');
    assert.include(output, 'Restored detailed inventory preference: include.');
    assert.include(output, 'proposals only');
  });

  it('never turns restored positive selections into new-installation prompt defaults', () => {
    const { result, prompts, output } = review({
      proposals: { includeRaw: true, includeDetailed: false },
      responses: ['', '', 'y'],
    });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: false, includeDetailed: false } });
    assert.isTrue(prompts.every((prompt) => prompt.includes('[y/N]')));
    assert.include(output, 'Restored raw configuration preference: include.');
    assert.include(output, 'Restored detailed inventory preference: exclude.');
  });

  it('handles a single restored proposal without inventing the other choice', () => {
    const { output } = review({ proposals: { includeDetailed: true }, responses: ['', '', 'y'] });
    assert.notInclude(output, 'Restored raw configuration preference:');
    assert.include(output, 'Restored detailed inventory preference: include.');
    const rawOnly = review({ proposals: { includeRaw: false }, responses: ['', '', 'y'] });
    assert.include(rawOnly.output, 'Restored raw configuration preference: exclude.');
    assert.notInclude(rawOnly.output, 'Restored detailed inventory preference:');
  });

  it('allows independent choices, trims answers, and repeats invalid answers', () => {
    const { result, prompts, output } = review({ responses: ['maybe', ' NO ', ' Yes ', 'y'] });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: false, includeDetailed: true } });
    assert.lengthOf(prompts, 4);
    assert.equal(prompts[0], prompts[1]);
    assert.include(output, 'Enter yes or no');
  });

  it('uses a locally enabled detailed preference as its default', () => {
    const { result, prompts } = review({
      localConfig: { backup: { includeRaw: false, includeDetailed: true } },
      responses: ['', '', 'yes'],
    });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: false, includeDetailed: true } });
    assert.include(prompts[1], '[Y/n]');
  });

  [
    [],
    [null],
    ['yes', null],
    ['no', 'yes', null],
    ['yes', 'yes', ''],
    ['yes', 'yes', 'no'],
  ].forEach((responses) => {
    it(`cancels without persistence for responses ${JSON.stringify(responses)}`, () => {
      assert.deepEqual(review({ responses }).result, { status: 'cancelled' });
    });
  });

  it('fails invalid local inclusion rather than treating it as consent', () => {
    const { result, prompts, output } = review({
      localConfig: { backup: { includeRaw: 'DUMMY_INVALID_SECRET' } },
      responses: ['yes', 'yes', 'yes'],
    });
    assert.deepEqual(result, { status: 'failed' });
    assert.deepEqual(prompts, []);
    assert.include(output, 'repair invalid local configuration');
    assert.notInclude(output, 'DUMMY_INVALID_SECRET');
  });

  it('does not discover excluded raw sources or run inventory discovery and collectors during review', () => {
    const definitions = snapshotDefinitions as SnapshotDefinition[];
    const originals = definitions.map(({ discover }) => discover);
    try {
      definitions.forEach((definition) => {
        definition.discover = () => { throw new Error('No source discovery expected'); };
      });
      assert.deepEqual(review({ responses: ['n', 'y', 'y'] }).result, {
        status: 'confirmed', inclusion: { includeRaw: false, includeDetailed: true },
      });
      definitions.forEach((definition, index) => {
        if (definition.inclusionGroup === 'raw') {
          definition.discover = originals[index];
        }
      });
      assert.deepEqual(review({ responses: ['y', 'y', 'y'] }).result, {
        status: 'confirmed', inclusion: { includeRaw: true, includeDetailed: true },
      });
    } finally {
      definitions.forEach((definition, index) => { definition.discover = originals[index]; });
    }
  });

  it('reviews selected normal files and symlinks outside HOME without exposing or changing raw contents', () => {
    const outsideFile = path.join(fixtureRoot, 'dotfiles', 'zshrc');
    const rawContent = 'export DUMMY_TOKEN=arbitrary-sensitive-content\nprivate-url=https://dummy.invalid/secret\n';
    fs.mkdirSync(path.dirname(outsideFile));
    fs.writeFileSync(outsideFile, rawContent);
    const logicalPath = path.join(homeDir, '.zshrc');
    fs.symlinkSync(outsideFile, logicalPath);
    const normalFile = path.join(homeDir, '.bashrc');
    fs.writeFileSync(normalFile, rawContent);
    const { result, output } = review({ responses: ['yes', 'no', 'yes'] });
    assert.deepEqual(result, { status: 'confirmed', inclusion: { includeRaw: true, includeDetailed: false } });
    assert.include(output, `${JSON.stringify(logicalPath)} -> ${JSON.stringify(fs.realpathSync(outsideFile))}`);
    assert.include(output, `${JSON.stringify(normalFile)} -> ${JSON.stringify(fs.realpathSync(normalFile))}`);
    assert.include(output, 'bash_profile.sh: absent (source-not-found)');
    assert.include(output, 'vs_settings: unavailable (app-unavailable)');
    assert.notInclude(output, 'arbitrary-sensitive-content');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), rawContent);
    assert.equal(fs.readFileSync(normalFile, 'utf8'), rawContent);
    assert.isTrue(fs.lstatSync(logicalPath).isSymbolicLink());
  });

  it('reviews normal symlinked editor configuration while never recursively capturing its directory', () => {
    const editorRoot = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
    const target = path.join(fixtureRoot, 'editor-settings.json');
    fs.mkdirSync(editorRoot, { recursive: true });
    fs.writeFileSync(target, '{"dummyToken":"never-print-me"}');
    fs.writeFileSync(path.join(editorRoot, 'unselected-secret.json'), 'not a selected source');
    fs.symlinkSync(target, path.join(editorRoot, 'settings.json'));
    const { result, output } = review({ responses: ['y', 'n', 'y'] });
    assert.equal(result.status, 'confirmed');
    assert.include(output, `vs_settings: ${JSON.stringify(path.join(editorRoot, 'settings.json'))} -> ${JSON.stringify(fs.realpathSync(target))}`);
    assert.notInclude(output, 'unselected-secret.json');
    assert.notInclude(output, 'never-print-me');
  });

  it('distinguishes missing targets and unsupported source types from resolution failures', () => {
    fs.symlinkSync('not-present', path.join(homeDir, '.bashrc'));
    fs.mkdirSync(path.join(homeDir, '.zshrc'));
    const { result, output } = review({ responses: ['y', 'n', 'y'] });
    assert.equal(result.status, 'confirmed');
    assert.include(output, 'bashrc.sh: absent (source-not-found)');
    assert.include(output, 'zshrc.sh: unavailable (unsupported-source-type)');
  });

  it('fails review before final confirmation when a selected raw symlink loops', () => {
    fs.symlinkSync('.zshrc', path.join(homeDir, '.zshrc'));
    const { result, prompts, output } = review({ responses: ['y', 'n', 'y'] });
    assert.deepEqual(result, { status: 'failed' });
    assert.lengthOf(prompts, 2);
    assert.include(output, 'Unable to review zshrc.sh: source discovery failed.');
  });

  it('fails closed if a selected source cannot be resolved after discovery', () => {
    fs.writeFileSync(path.join(homeDir, '.zshrc'), 'secret stays local');
    const originalRealpath = fs.realpathSync;
    try {
      fs.realpathSync = () => { throw new Error('DUMMY_PRIVATE_ERROR'); };
      const { result, output } = review({ responses: ['y', 'n', 'y'] });
      assert.deepEqual(result, { status: 'failed' });
      assert.include(output, 'Unable to review zshrc.sh: source access or resolution failed.');
      assert.notInclude(output, 'DUMMY_PRIVATE_ERROR');
    } finally {
      fs.realpathSync = originalRealpath;
    }
  });

  it('fails closed for a malformed available raw observation without a file path', () => {
    const definition = (snapshotDefinitions as SnapshotDefinition[]).find(({ name }) => name === 'zshrc.sh')!;
    const originalDiscover = definition.discover;
    try {
      definition.discover = () => ({
        status: 'available',
        source: { kind: 'file', name: '.zshrc' },
        collector: { fileName: 'zshrc.sh', command: 'must-not-run' },
      });
      const { result, output } = review({ responses: ['y', 'n', 'y'] });
      assert.deepEqual(result, { status: 'failed' });
      assert.include(output, 'Unable to review zshrc.sh: no file source was resolved.');
    } finally {
      definition.discover = originalDiscover;
    }
  });
});
