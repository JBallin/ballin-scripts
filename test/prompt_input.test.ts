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
  for (const transport of ['node', 'bash']) {
    for (const partial of ['', 'yes']) {
      for (const control of ['EOF', 'SIGINT']) {
        it(`keeps terminal ${control} distinct from a completed ${transport} answer after ${JSON.stringify(partial)}`, () => {
          sandbox = createSandbox();
          const script = path.join(sandbox.root, transport === 'node' ? 'control.cjs' : 'control.sh');
          fs.writeFileSync(script, transport === 'node'
            ? `const h=require(${JSON.stringify(path.resolve(__dirname, '../commands/commandHelpers.ts'))});
              const answer=h.readYesNo('Consent? [y/N] '); if(answer===null) console.log('ENDED');
              else { require('fs').writeFileSync(process.argv[2],String(answer)); console.log('ANSWERED'); }`
            : `source '${path.resolve(__dirname, '../quickstart.sh')}'
              trap cleanup EXIT
              if confirm 'Consent?'; then printf 'yes' > "$1"; elif "$input_ended"; then printf 'ENDED\\n'; else printf 'no' > "$1"; fi`);
          const marker = path.join(sandbox.root, 'answer-saved');
          const result = runInteractiveSetup(sandbox, [transport === 'node' ? process.execPath : '/bin/bash', script, marker], [
            { prompt: 'Consent? [y/N] ', answer: partial + (control === 'SIGINT' ? '\x03' : partial ? '\x04\x04' : '\x04'), raw: true },
          ]);
          assert.equal(result.status, control === 'SIGINT' ? 130 : 0, result.stdout + result.stderr);
          assert.isFalse(fs.existsSync(marker));
          if (control === 'EOF') assert.include(result.stdout, 'ENDED');
          else assert.notInclude(result.stdout, 'ENDED');
        });
      }
    }
  }
  for (const input of ['', 'yes', 'NO']) {
    it(`discards redirected partial EOF ${JSON.stringify(input)} without selecting the default`, () => {
      const result = spawnSync(process.execPath, ['-e', `const h=require(process.argv[1]); console.log(h.readYesNo('Answer? ', true));`, path.resolve(__dirname, '../commands/commandHelpers.ts')], {
        encoding: 'utf8', input, env: testChildEnvironment(),
      });
      assert.equal(result.status, 0); assert.equal(result.stdout, 'Answer? \nnull\n');
    });
  }
  it('normalizes complete yes/no answers and reprompts invalid text without echoing it', () => {
    const result = spawnSync(process.execPath, ['-e', `const h=require(process.argv[1]); console.log(h.readYesNo('First? '),h.readYesNo('Second? ',true));`, path.resolve(__dirname, '../commands/commandHelpers.ts')], {
      encoding: 'utf8', input: 'PRIVATE_INVALID\n  YeS \r\n \t nO \t\n', env: testChildEnvironment(),
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'First? \nPlease enter yes or no.\nFirst? \nSecond? \ntrue false\n');
  });
  for (const fault of ['closed-stdin', 'temporary-file']) {
    it(`reports Bash ${fault} failure instead of choosing No or EOF`, () => {
      const script = `source "$1"; trap cleanup EXIT; ${fault === 'closed-stdin' ? 'exec 0<&-' : 'mktemp() { return 1; }'}; if confirm 'Answer?'; then echo YES; else echo NO; fi`;
      const result = spawnSync('/bin/bash', ['-c', script, 'fixture', path.resolve(__dirname, '../quickstart.sh')], {
        encoding: 'utf8', env: testChildEnvironment({ PATH: '/usr/bin:/bin' }),
      });
      assert.equal(result.status, 1); assert.match(result.stderr, /Unable to (?:read|prepare) prompt input/u);
      assert.notInclude(result.stdout, 'YES'); assert.notInclude(result.stdout, 'NO');
    });
  }
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
    assert.equal(result.stdout, 'KEEP THIS ROW\nDefault no? [y/N] \nDefault yes? [Y/n] \nExplicit yes? [y/N] \nExplicit no? [Y/n] \nDONE\n');
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
          { prompt: 'Run a backup now and open its GitHub destination? [Y/n] ', answer: '' },
          { prompt: 'Explicit yes? [y/N] ', answer: 'Y' },
          { prompt: 'Run a backup now and open its GitHub destination? [Y/n] ', answer: 'N' }]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'KEEP THIS ROW'); assert.include(result.stdout, 'DONE');
      assert.notInclude(result.stdout, '\x1b'); assert.notMatch(result.stdout, /(?:Selected|First backup): (?:Yes|No)/u);
    });
  }
});
