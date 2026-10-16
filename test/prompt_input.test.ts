const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { Sandbox } from './helpers/onboarding.ts';

// Presentation must never construct stdin, consume typeahead, echo private input,
// or move the cursor. Caller suites cover the actual default/save/consent policies.
describe('plain prompt input contracts', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  afterEach(() => { if (sandbox && fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });
  const nodeFixture = (expected: string[]) => {
    sandbox = createSandbox();
    const script = path.join(sandbox.root, 'prompt-fixture.cjs');
    fs.writeFileSync(script, `Object.defineProperty(process, 'stdin', { get() { throw Error('stdin initialized'); } });
      const { readPromptLine } = require(${JSON.stringify(path.resolve(__dirname, '../commands/commandHelpers.ts'))});
      console.log('KEEP THIS ROW');
      const prompts = ['Default no? [y/N] ', 'Default yes? [Y/n] ', 'Explicit yes? [y/N] ', 'Explicit no? [Y/n] '];
      const actual = prompts.map(prompt => readPromptLine(prompt));
      if (JSON.stringify(actual) !== JSON.stringify(${JSON.stringify(expected.map(text => ({ text, eof: false })))})) throw Error('Answers changed');
      console.log('DONE');`);
    return [process.execPath, script];
  };
  for (const mode of ['delayed', 'typeahead', 'narrow', 'no-echo']) {
    it(`keeps real-terminal ${mode} input intact without cursor movement or answer echoes`, () => {
      const command = nodeFixture(['', '', 'Y', 'n']);
      const answers = mode === 'typeahead'
        ? [{ prompt: 'Default no? [y/N] ', answer: '\n\nY\nn' }]
        : ['Default no? [y/N] ', 'Default yes? [Y/n] ', 'Explicit yes? [y/N] ', 'Explicit no? [Y/n] ']
          .map((prompt, index) => ({ prompt, answer: ['', '', 'Y', 'n'][index] }));
      const result = runInteractiveSetup(sandbox, command, answers, undefined, { columns: mode === 'narrow' ? 10 : 120, echo: mode !== 'no-echo' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'KEEP THIS ROW'); assert.include(result.stdout, 'DONE');
      assert.notInclude(result.stdout, '\x1b'); assert.notMatch(result.stdout, /^(?:Yes|No)\.?$/mu);
    });
  }
  it('keeps redirected input and arbitrary private answers out of output', () => {
    const command = nodeFixture(['y', 'n', '', 'synthetic-private-answer']);
    const result = spawnSync(command[0], command.slice(1), { input: 'y\nn\n\nsynthetic-private-answer\n', encoding: 'utf8', env: testChildEnvironment({ HOME: sandbox.home, PATH: sandbox.tools }) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'KEEP THIS ROW\nDefault no? [y/N] Default yes? [Y/n] Explicit yes? [y/N] Explicit no? [Y/n] DONE\n');
    assert.notInclude(result.stdout, 'synthetic-private-answer');
  });
  for (const typeahead of [false, true]) {
    it(`preserves quickstart defaults and final backup consent with ${typeahead ? 'pasted' : 'delayed'} terminal answers`, () => {
      sandbox = createSandbox();
      const script = path.join(sandbox.root, 'shell-prompts.sh');
      fs.writeFileSync(script, `source '${path.resolve(__dirname, '../quickstart.sh')}'
        printf 'KEEP THIS ROW\\n'
        confirm 'Default no?' && exit 81
        confirm_first_backup || exit 82
        confirm 'Explicit yes?' || exit 83
        confirm_first_backup && exit 84
        printf 'DONE\\n'`);
      const result = runInteractiveSetup(sandbox, ['/bin/bash', script], typeahead
        ? [{ prompt: 'Default no? [y/N] ', answer: '\n\ny\nn' }]
        : [{ prompt: 'Default no? [y/N] ', answer: '' },
          { prompt: 'Run your first backup and open its GitHub destination? [Y/n] ', answer: '' },
          { prompt: 'Explicit yes? [y/N] ', answer: 'Y' },
          { prompt: 'Run your first backup and open its GitHub destination? [Y/n] ', answer: 'N' }]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'KEEP THIS ROW'); assert.include(result.stdout, 'DONE');
      assert.notInclude(result.stdout, '\x1b'); assert.notMatch(result.stdout, /(?:Selected|First backup): (?:Yes|No)/u);
    });
  }
});
