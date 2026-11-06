const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
import type { Sandbox } from './helpers/onboarding.ts';

// Actual PTYs and readers; only the read-only metadata/poll result is faulted.
// Presentation failures must not consume answers, mutate checkout state, or mask interruption.
const faults = [
  { mode: 'stat-throw' }, { mode: 'not-character' }, { mode: 'different-device' },
  { mode: 'stty-throw' }, { mode: 'stty-timeout' }, { mode: 'stty-status' },
  { mode: 'stty-int', interrupt: 130 }, { mode: 'stty-term-status', interrupt: 143 },
  { mode: 'missing-rows' }, { mode: 'missing-columns' }, { mode: 'missing-echo' },
  { mode: 'noncanonical' }, { mode: 'no-onlcr' }, { mode: 'tiny-rows' }, { mode: 'zero-columns' },
  { mode: 'poll-error' }, { mode: 'poll-status' },
  { mode: 'poll-signal', interrupt: 143 }, { mode: 'poll-int-status', interrupt: 130 },
  { mode: 'resize' }, { mode: 'echo-change' }, { mode: 'second-probe-failed' },
  { mode: 'post-poll-term', interrupt: 143, answer: true },
  { mode: 'viewport' }, { mode: 'control-answer' },
  { mode: 'bsd-layout', paint: true }, { mode: 'exported-function', paint: true },
];
const probeFault = (mode: string): string => `
const fs=require('node:fs'),cp=require('node:child_process');
const mode=${JSON.stringify(mode)}, originalStat=fs.fstatSync, originalSpawn=cp.spawnSync;
let metadata=0,polls=0;
fs.fstatSync=function(fd,...args){
 if(fd===0&&mode==='stat-throw')throw Error('private_probe_failure');
 const value=originalStat.call(this,fd,...args);
 if(fd===0&&mode==='not-character')return {isCharacterDevice:()=>false};
 if(fd===1&&mode==='different-device')return {isCharacterDevice:()=>true,rdev:value.rdev+1};
 return value;
};
if(mode==='exported-function')process.env['BASH_FUNC_fixture%%']='() { false; }';
cp.spawnSync=function(command,args,options){
 if(command==='/bin/stty'){
  metadata++;
  if(mode==='stty-throw')throw Error('private_probe_failure');
  if(mode==='stty-timeout')return {error:Error('private_probe_failure'),status:null,signal:'SIGTERM'};
  if(mode==='stty-int')return {status:null,signal:'SIGINT'};
  if(mode==='stty-term-status')return {status:143,signal:null};
  if(mode==='stty-status'||(mode==='second-probe-failed'&&metadata>1))return {status:1,signal:null};
  let flags='rows 24; columns 120; echo icanon onlcr;';
  if(mode==='bsd-layout')flags='24 rows; 120 columns; echo icanon onlcr;';
  if(mode==='missing-rows')flags=flags.replace('rows 24;','');
  if(mode==='missing-columns')flags=flags.replace('columns 120;','');
  if(mode==='missing-echo')flags=flags.replace('echo ','');
  if(mode==='noncanonical')flags=flags.replace('icanon','-icanon');
  if(mode==='no-onlcr')flags=flags.replace('onlcr','-onlcr');
  if(mode==='tiny-rows')flags=flags.replace('rows 24','rows 1');
  if(mode==='zero-columns')flags=flags.replace('columns 120','columns 0');
  if(mode==='resize'&&metadata>1)flags=flags.replace('columns 120','columns 119');
  if(mode==='echo-change'&&metadata>1)flags=flags.replace('echo ','-echo ');
  if(mode==='viewport')flags=flags.replace('columns 120','columns 1').replace('rows 24','rows 2');
  return {status:0,signal:null,stdout:flags,stderr:''};
 }
 if(command==='/bin/zsh'){
  polls++;
  if(mode==='poll-error')return {error:Error('private_probe_failure'),status:null,signal:null};
  if(mode==='poll-status')return {status:2,signal:null};
  if(mode==='poll-signal'||(mode==='post-poll-term'&&polls>1))return {status:null,signal:'SIGTERM'};
  if(mode==='poll-int-status')return {status:130,signal:null};
 }
 // This suite's Git executable is a Node mock with no included product code.
 // Avoid hundreds of irrelevant profiles; retain coverage on the actual readers.
 if(command==='git')options={...options,env:{...(options?.env??process.env),NODE_V8_COVERAGE:''}};
 return originalSpawn.call(this,command,args,options);
};
`;

describe('prompt presentation probe failures', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  before(() => {
    sandbox = createSandbox({ quickstart: true });
    const installed = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  });
  after(() => { if (sandbox && fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });
  for (const reader of ['shared', 'standalone']) for (const fault of faults) {
    it(`preserves ${reader} consent and checkout state with ${fault.mode}`, () => {
      const preload = path.join(sandbox.root, 'probe-fault.cjs');
      fs.writeFileSync(preload, probeFault(fault.mode));
      const receipt = path.join(sandbox.repo, '.git/ballin-install.json');
      const before = fs.readFileSync(receipt);
      const command = reader === 'shared'
        ? [process.execPath, '--require', preload, '-e',
          `try { console.log('DONE:'+require(process.argv[1]).readYesNo('Proceed? [y/N] ')); }
           catch(error) { if(!error.status)throw error; console.log('INTERRUPTED:'+error.status); process.exitCode=error.status; }`,
          path.resolve(__dirname, '../commands/commandHelpers.ts')]
        : [process.execPath, '--require', preload, path.resolve(__dirname, '../commands/repo_update.ts'),
          'apply', sandbox.repo, 'sha', 'a'.repeat(40), 'a'.repeat(40), '24.12.0', '-', 'install', 'false'];
      const response = fault.interrupt && !fault.answer ? [] : [{
        prompt: reader === 'shared' ? 'Proceed? [y/N] ' : 'Change the installed revision/track? [y/N] ',
        answer: fault.mode === 'control-answer' ? '\tN' : 'N',
      }];
      const result = runInteractiveSetup(sandbox, command, response);
      assert.equal(result.status, fault.interrupt ?? (reader === 'shared' ? 0 : 20), result.stdout + result.stderr);
      if (!fault.interrupt) assert.include(result.stdout, reader === 'shared' ? 'DONE:false' : 'Revision change cancelled.');
      if (fault.paint) assert.include(result.stdout, '\x1b[36mNo\x1b[0m');
      else assert.notInclude(result.stdout, '\x1b[36m');
      assert.notInclude(result.stdout, '\x1b[1mN\x1b[0m');
      if (!fault.interrupt) assert.include(result.stdout, reader === 'shared' ? 'Proceed? [y/N] ' : 'Change the installed revision/track? [y/N] ');
      assert.notInclude(result.stdout + result.stderr, 'private_probe_failure');
      assert.deepEqual(fs.readFileSync(receipt), before);
    });
  }
});
