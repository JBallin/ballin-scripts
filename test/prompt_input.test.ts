const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { Sandbox } from './helpers/onboarding.ts';

// Presentation must never construct stdin, consume typeahead, echo private input,
// or repaint unaccepted/free text. Caller suites cover default/save/consent policies.
// Replay only the terminal operations these prompt fixtures emit. This checks
// the resulting screen, rather than treating old echoed bytes as visible output.
const promptScreen = (output: string, columns: number): string => {
  const lines: string[][] = [[]]; let row = 0, column = 0, wrap = false;
  const ensure = () => { while (lines.length <= row) lines.push([]); };
  for (let index = 0; index < output.length;) {
    const csi = /^\x1b\[([0-9;]*)([A-Za-z])/u.exec(output.slice(index));
    if (csi) {
      const [, argument, operation] = csi;
      if (operation === 'A') row = Math.max(0, row - Number(argument || 1));
      else if (operation === 'J' && !argument) { ensure(); lines[row].length = column; lines.length = row + 1; }
      else assert.equal(operation, 'm', 'Unexpected terminal operation');
      wrap = false; index += csi[0].length; continue;
    }
    const character = output[index++];
    if (character === '\r') { column = 0; wrap = false; continue; }
    if (character === '\n') { row++; wrap = false; ensure(); continue; }
    if (wrap) { row++; column = 0; ensure(); wrap = false; }
    ensure(); lines[row][column] = character;
    if (++column === columns) { column = columns - 1; wrap = true; }
  }
  return lines.map(line => line.join('')).join('\n');
};

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
  for (const mode of ['normal', 'narrow', 'no-echo']) it(`shows the accepted answer in the owned prompt region with ${mode} geometry`, () => {
    sandbox = createSandbox();
    const columns = mode === 'narrow' ? 10 : 120;
    const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
      `const h=require(process.argv[1]); console.log('KEEP'); h.readYesNo('Proceed? [y/N] '); console.log('DONE');`,
      path.resolve(__dirname, '../commands/commandHelpers.ts')], [{ prompt: 'Proceed? [y/N] ', answer: 'Y' }], undefined,
    { columns, echo: mode !== 'no-echo' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const screen = promptScreen(result.stdout, columns).replaceAll('\n', '');
    assert.include(screen, 'KEEP? Proceed? [y/N] YesDONE');
    assert.notInclude(screen, '[y/N] YYes');
  });
  for (const [input, label] of [['login', 'login'], ['bashrc', 'bashrc'], ['', 'Skip'], ['LOGIN', undefined], [' login ', undefined], ['none', undefined]]) {
    it(`preserves Bash startup selection semantics for ${JSON.stringify(input)}`, () => {
      sandbox = createSandbox();
      const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
        `const h=require(process.argv[1]); const c=require(process.argv[2]); const target=c.completionTarget({HOME:process.env.HOME,SHELL:'/bin/bash'},h.readPromptLine); console.log('TARGET:'+Boolean(target));`,
        path.resolve(__dirname, '../commands/commandHelpers.ts'), path.resolve(__dirname, '../commands/completion_setup.ts')],
      [{ prompt: '[login/bashrc; Enter to skip] ', answer: input },
        ...(!label ? [{ prompt: 'Enter login or bashrc.', answer: '\x04', raw: true }] : [])]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'TARGET:' + String(input === 'login' || input === 'bashrc'));
      if (label) assert.include(result.stdout, '\x1b[36m' + label + '\x1b[0m');
      else assert.notInclude(result.stdout, '\x1b[36m');
    });
  }
  it('leaves an invalid answer unconfirmed before accepting a valid retry', () => {
    sandbox = createSandbox();
    const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
      `require(process.argv[1]).readYesNo('Proceed? [y/N] ');`, path.resolve(__dirname, '../commands/commandHelpers.ts')],
    [{ prompt: 'Proceed? [y/N] ', answer: 'invalid' }, { prompt: 'Enter Yes or No.', answer: 'Y' }]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(result.stdout, '\x1b[36minvalid');
    const screen = promptScreen(result.stdout, 120);
    assert.include(screen, '? Proceed? [y/N] invalid');
    assert.include(screen, '? Proceed? [y/N] Yes');
  });
  for (const [input, expected] of [['n', 'No'], ['', 'Create'], ['reconnect', 'Reconnect'], ['constructor', undefined]]) {
    it(`confirms only an accepted fixed-choice label for ${JSON.stringify(input)}`, () => {
      sandbox = createSandbox();
      const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
        `const h=require(process.argv[1]); const a=h.readPromptLine('Choice [CREATE/reconnect] ', text => text === '' ? 'Create' : text === 'n' ? 'No' : text === 'reconnect' ? 'Reconnect' : undefined); console.log('RAW:'+a.text);`,
        path.resolve(__dirname, '../commands/commandHelpers.ts')], [{ prompt: 'Choice [CREATE/reconnect] ', answer: input }]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'RAW:' + input);
      assert.include(result.stdout, '\x1b[1;32m?\x1b[0m Choice [CREATE/reconnect] ');
      assert.notInclude(result.stdout, '\x1b[1mCREATE\x1b[0m');
      if (expected) assert.include(result.stdout, '\x1b[36m' + expected + '\x1b[0m');
      else assert.notInclude(result.stdout, '\x1b[36m', JSON.stringify(result.stdout));
    });
  }
  for (const mode of ['dumb', 'NO_COLOR']) it(`leaves accepted input plain for ${mode}`, () => {
    sandbox = createSandbox();
    const command = [process.execPath, '-e', `require(process.argv[1]).readYesNo('Proceed? [y/N] ');`, path.resolve(__dirname, '../commands/commandHelpers.ts')];
    const result = runInteractiveSetup(sandbox, mode === 'NO_COLOR' ? ['/usr/bin/env', 'NO_COLOR=1', ...command] : command,
      [{ prompt: 'Proceed? [y/N] ', answer: 'Y' }], undefined, { term: mode === 'dumb' ? 'dumb' : 'xterm' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(result.stdout, '\x1b[');
  });
  it('does not consume pasted fixed-choice answers or repaint their pending echoes', () => {
    sandbox = createSandbox();
    const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
      `const h=require(process.argv[1]); const answers=[h.readYesNo('First? [y/N] '),h.readYesNo('Second? [y/N] ')]; console.log('ANSWERS:'+JSON.stringify(answers));`,
      path.resolve(__dirname, '../commands/commandHelpers.ts')], [{ prompt: 'First? [y/N] ', answer: 'y\nn' }]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'ANSWERS:[true,false]');
    assert.notInclude(result.stdout, '\x1b[36m', JSON.stringify(result.stdout));
  });
  it('accepts Y with one Enter and redraws its canonical answer on the prompt line', () => {
    sandbox = createSandbox();
    const script = `const h=require(process.argv[1]); console.log('KEEP'); const answer=h.readYesNo('Proceed? [y/N] '); console.log('DONE:'+answer);`;
    const result = runInteractiveSetup(sandbox, [process.execPath, '-e', script, path.resolve(__dirname, '../commands/commandHelpers.ts')], [
      { prompt: 'Proceed? [y/N] ', answer: 'Y' },
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '\x1b[36mYes\x1b[0m');
    assert.include(result.stdout, '\x1b[1A\r\x1b[J');
    assert.include(result.stdout, 'DONE:true');
    assert.notInclude(result.stdout + result.stderr, 'EAGAIN');
  });
  for (const defaultValue of [true, false]) it(`confirms empty Enter as the TypeScript default ${defaultValue ? 'Yes' : 'No'}`, () => {
    sandbox = createSandbox();
    const choices = defaultValue ? '[Y/n]' : '[y/N]', label = defaultValue ? 'Yes' : 'No';
    const result = runInteractiveSetup(sandbox, [process.execPath, '-e',
      `const h=require(process.argv[1]); console.log('KEEP'); console.log('DONE:'+h.readYesNo('Proceed? ${choices} ',${defaultValue}));`,
      path.resolve(__dirname, '../commands/commandHelpers.ts')], [{ prompt: 'Proceed? ' + choices + ' ', answer: '' }]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '\x1b[36m' + label + '\x1b[0m');
    assert.include(result.stdout, '\x1b[1;32m?\x1b[0m Proceed? ' + choices + ' ');
    assert.include(promptScreen(result.stdout, 120), 'KEEP\n? Proceed? ' + choices + ' ' + label + '\nDONE:' + defaultValue);
  });
  for (const file of ['install.sh', 'quickstart.sh']) for (const [input, defaultValue, label] of [['Y', 'n', 'Yes'], ['', 'n', 'No'], ['', 'y', 'Yes']]) {
    it(`accepts ${JSON.stringify(input)} with one Enter in ${file} with default ${defaultValue}`, () => {
      sandbox = createSandbox();
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const helpers = ['status_marker', 'choice_word', 'fixed_prompt_layout', 'render_fixed_prompt', 'confirm_fixed_choice', 'prompt_choices', 'read_prompt_answer', 'confirm'].map((name) => {
        const helper = source.match(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?^\\}', 'mu'))?.[0];
        assert.isString(helper); return helper;
      }).join('\n');
      const script = `${helpers}\nprompt_error=''; input_ended=false; printf 'KEEP\\n'; if confirm 'Proceed?' ${defaultValue}; then printf 'DONE:true\\n'; else printf 'DONE:false\\n'; fi`;
      const choices = defaultValue === 'y' ? '[Y/n]' : '[y/N]';
      const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', script], [
        { prompt: 'Proceed? ' + choices + ' ', answer: input },
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, '\x1b[36m' + label + '\x1b[0m');
      assert.include(result.stdout, '\x1b[1;32m?\x1b[0m Proceed? ' + choices + ' ');
      assert.include(promptScreen(result.stdout, 120), 'KEEP\n? Proceed? ' + choices + ' ' + label + '\nDONE:' + String(label === 'Yes'));
    });
  }
  for (const file of ['install.sh', 'quickstart.sh']) {
    it(`uses concise Yes/No retry guidance without confirming invalid input in ${file}`, () => {
      sandbox = createSandbox();
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const helpers = ['status_marker', 'choice_word', 'fixed_prompt_layout', 'render_fixed_prompt', 'confirm_fixed_choice', 'prompt_choices', 'read_prompt_answer', 'confirm'].map((name) => {
        const helper = source.match(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?^\\}', 'mu'))?.[0];
        assert.isString(helper); return helper;
      }).join('\n');
      const script = `${helpers}\nprompt_error=''; input_ended=false; if confirm 'Proceed?'; then printf 'DONE:true\\n'; else printf 'DONE:false\\n'; fi`;
      const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', script], [
        { prompt: 'Proceed? [y/N] ', answer: 'invalid' },
        { prompt: 'Enter Yes or No.', answer: 'Y' },
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Enter Yes or No.');
      assert.notInclude(result.stdout, 'Please enter');
      assert.notInclude(result.stdout, '\x1b[36minvalid');
      assert.include(result.stdout, '\x1b[36mYes\x1b[0m');
      assert.include(result.stdout, 'DONE:true');
    });
  }
  for (const [answer, label] of [['Y', 'Yes'], ['N', 'No'], ['', 'No'], ['\x04', undefined]]) {
    it(`keeps the completion consent target visible and preserves ${JSON.stringify(answer)} behavior`, () => {
      sandbox = createSandbox();
      const script = `const c=require(process.argv[1]); c.offerCompletionSetup('https://example.test/install', {interactive:true,env:{...process.env,SHELL:'/bin/bash',BALLIN_SETUP_PROFILE:process.env.HOME+'/.bashrc'}});`;
      const result = runInteractiveSetup(sandbox, [process.execPath, '-e', script, path.resolve(__dirname, '../commands/completion_setup.ts')], [
        { prompt: 'Enable Ballin tab completion in ~/.bashrc? [y/N] ', answer, raw: label === undefined },
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      assert.notInclude(output, 'File to update:');
      assert.notInclude(output, 'Startup file:');
      assert.include(output, '\x1b[1;32m?\x1b[0m Enable Ballin tab completion in ~/.bashrc? [y/N] ');
      assert.notInclude(output, 'Optional tab completion');
      assert.notInclude(output, '\x1b[1mN\x1b[0m');
      if (label) assert.include(output, '\x1b[36m' + label + '\x1b[0m');
      else assert.notInclude(output, '\x1b[36m');
      if (label === 'Yes') {
        assert.include(output, 'Tab completion enabled.');
        assert.notInclude(output, 'Enable it later');
        assert.notInclude(output, 'https://');
        assert.include(fs.readFileSync(path.join(sandbox.home, '.bashrc'), 'utf8'), 'ballin.bash');
      } else {
        assert.include(output, 'Enable it later:');
        assert.include(output, 'example.test/install#startup-files-and-manual-activation');
        assert.equal(output.includes('Tab completion skipped.'), label === undefined);
        assert.isFalse(fs.existsSync(path.join(sandbox.home, '.bashrc')));
      }
    });
  }
  for (const display of [
    { name: 'wide', columns: 120, term: 'xterm', noColor: false },
    { name: 'narrow', columns: 32, term: 'xterm', noColor: false },
    { name: 'dumb', columns: 32, term: 'dumb', noColor: false },
    { name: 'NO_COLOR', columns: 32, term: 'xterm', noColor: true },
  ]) {
    it(`keeps a long custom completion target inline before default-No consent (${display.name})`, () => {
      sandbox = createSandbox();
      const directory = path.join(sandbox.home, 'custom settings', 'z'.repeat(90));
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, '.zshrc');
      const question = `Enable Ballin tab completion in ~/custom settings/${'z'.repeat(90)}/.zshrc? [y/N] `;
      const script = `if(process.argv[3]==='true')process.env.NO_COLOR='1';
        console.log('KEEP');require(process.argv[1]).offerCompletionSetup('guide',
        {interactive:true,env:{...process.env,SHELL:'/bin/zsh',BALLIN_SETUP_PROFILE:process.argv[2]}});console.log('DONE');`;
      const result = runInteractiveSetup(sandbox, [process.execPath, '-e', script,
        path.resolve(__dirname, '../commands/completion_setup.ts'), target, String(display.noColor)],
      [{ prompt: question, answer: '' }], undefined, { columns: display.columns, term: display.term });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, question);
      assert.notInclude(result.stdout, 'File to update:');
      assert.notInclude(result.stdout, 'Zsh settings directory');
      assert.isFalse(fs.existsSync(target));
      const screen = promptScreen(result.stdout, display.columns).replaceAll('\n', '');
      assert.include(screen, 'KEEP'); assert.include(screen, 'z'.repeat(90)); assert.include(screen, 'DONE');
      assert.isBelow(screen.indexOf('KEEP'), screen.indexOf('Enable Ballin tab completion'));
      assert.isBelow(screen.indexOf('Enable Ballin tab completion'), screen.indexOf('DONE'));
      if (display.term === 'dumb' || display.noColor) assert.notInclude(result.stdout, '\x1b');
      else assert.include(result.stdout, '\x1b[36mNo\x1b[0m');
    });
  }
  it('confirms empty Enter as Create in the actual backup setup flow without creating a destination', () => {
    sandbox = createSandbox({ quickstart: true });
    const installed = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'backup', 'setup'], [
      { prompt: 'GitHub hostname [github.com]: ', answer: '' },
      { prompt: '[CREATE/reconnect] ', answer: '' },
      { prompt: 'Repository name [ballin-backups]: ', answer: '' },
      { prompt: 'Include sensitive sources in future backups? [y/N] ', answer: '' },
      { prompt: 'Create this private GitHub backup without sensitive sources? [y/N] ', answer: '' },
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '\x1b[36mCreate\x1b[0m');
    assert.include(promptScreen(result.stdout, 120), '[CREATE/reconnect] Create');
    assert.include(result.stdout, 'Backup setup cancelled.');
    assert.isFalse(JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8')).exists);
  });
  for (const input of ['', 'yes', 'NO']) {
    it(`discards redirected partial EOF ${JSON.stringify(input)} without selecting the default`, () => {
      const result = spawnSync(process.execPath, ['-e', `const h=require(process.argv[1]); console.log(h.readYesNo('Answer? ', true));`, path.resolve(__dirname, '../commands/commandHelpers.ts')], {
        encoding: 'utf8', input, env: testChildEnvironment(),
      });
      assert.equal(result.status, 0); assert.equal(result.stdout, '? Answer? \nnull\n');
    });
  }
  it('normalizes complete yes/no answers and reprompts invalid text without echoing it', () => {
    const result = spawnSync(process.execPath, ['-e', `const h=require(process.argv[1]); console.log(h.readYesNo('First? '),h.readYesNo('Second? ',true));`, path.resolve(__dirname, '../commands/commandHelpers.ts')], {
      encoding: 'utf8', input: 'PRIVATE_INVALID\n  YeS \r\n \t nO \t\n', env: testChildEnvironment(),
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, '? First? \nEnter Yes or No.\n? First? \n? Second? \ntrue false\n');
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
      assert.notMatch(result.stdout, /\x1b\[[0-9;]*[A-HJKSTf]/u); assert.notMatch(result.stdout, /^(?:Yes|No)\.?$/mu);
    });
  }
  it('keeps redirected input and arbitrary private answers out of output', () => {
    const command = nodeFixture(['y', 'n', '', 'synthetic-private-answer']);
    const result = spawnSync(command[0], command.slice(1), { input: 'y\nn\n\nsynthetic-private-answer\n', encoding: 'utf8', env: testChildEnvironment({ HOME: sandbox.home, PATH: sandbox.tools }) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'KEEP THIS ROW\n? Default no? [y/N] \n? Default yes? [Y/n] \n? Explicit yes? [y/N] \n? Explicit no? [Y/n] \nDONE\n');
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
      if (typeahead) assert.notMatch(result.stdout, /\x1b\[[0-9;]*[A-HJKSTf]/u, JSON.stringify(result.stdout));
      else assert.include(result.stdout, '\x1b[36mYes\x1b[0m');
      assert.notMatch(result.stdout, /(?:Selected|First backup): (?:Yes|No)/u);
    });
  }
});
