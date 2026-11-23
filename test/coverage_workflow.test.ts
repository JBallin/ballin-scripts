const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const workflow = yaml.load(fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8',
)) as { jobs: { test: { steps: { name: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }[] } } };

const conditions = [
  'Capture coverage comparison evidence',
  'Package raw V8 coverage evidence',
] as const;

describe('coverage evidence workflow conditions', () => {
  for (const name of conditions) {
    it(`${name} preserves eligibility and skips hashing when ineligible`, () => {
      const condition = workflow.jobs.test.steps.find((step) => step.name === name)?.if;
      assert.isString(condition);
      assert.match(condition!, /^\$\{\{ !cancelled\(\) &&/u);
      // Exercise the actual YAML's boolean expression with string-valued contexts.
      // This models only these predicates, not the full Actions expression engine.
      const evaluate = new Function('cancelled', 'hashFiles', 'steps', 'github',
        `return (${condition!.replace(/^\$\{\{\s*|\s*\}\}$/gu, '')});`);

      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        for (const outcome of ['success', 'failure', 'skipped', 'cancelled']) {
          for (const cancelled of [false, true]) {
            for (const profiles of [false, true]) {
              for (const diagnostics of ['success', 'failure', 'skipped']) {
                const eligible = !cancelled && (outcome === 'failure'
                  || (event === 'workflow_dispatch' && outcome === 'success'));
                let hashCalls = 0;
                const actual = evaluate(
                  () => cancelled,
                  (pattern: string) => {
                    assert.equal(pattern, 'coverage/tmp/coverage-*.json');
                    hashCalls += 1;
                    return profiles ? 'profile-digest' : '';
                  },
                  { coverage: { outcome }, coverage_diagnostics: { outcome: diagnostics } },
                  { event_name: event },
                );
                const context = JSON.stringify({ event, outcome, cancelled, profiles, diagnostics });
                assert.strictEqual(actual, eligible && profiles, context);
                assert.strictEqual(hashCalls, eligible ? 1 : 0, context);
              }
            }
          }
        }
      }
    });
  }
});


describe('raw coverage archive delivery', () => {
  const steps = workflow.jobs.test.steps;
  const pack = steps.find((step) => step.name === 'Package raw V8 coverage evidence')!;
  const upload = steps.find((step) => step.name === 'Upload raw V8 coverage evidence')!;
  const download = steps.find((step) => step.name === 'Download raw V8 coverage evidence')!;
  const verify = steps.find((step) => step.name === 'Verify raw V8 coverage artifact round trip')!;
  it('uploads only a completed archive for failures or successful manual diagnostics, independently of compact reports', () => {
    assert.equal(pack.id, 'raw_coverage_archive');
    assert.equal(upload.with?.path, 'coverage/coverage-raw.tar.gz');
    assert.equal(upload.with?.['compression-level'], 0); assert.equal(upload.with?.['retention-days'], 7);
    assert.equal(upload.with?.['if-no-files-found'], 'error');
    const evaluate = new Function('cancelled', 'steps', 'github', `return (${upload.if!.replace(/^\$\{\{\s*|\s*\}\}$/gu, '')});`);
    for (const event of ['pull_request','push','workflow_dispatch']) for (const cancelled of [false,true]) for (const coverage of ['success','failure','skipped','cancelled']) {
      for (const archive of ['success','failure','skipped','cancelled']) for (const compact of ['success','failure','skipped']) {
        const eligible=coverage==='failure'||(event==='workflow_dispatch'&&coverage==='success');
        assert.strictEqual(evaluate(()=>cancelled,{coverage:{outcome:coverage},raw_coverage_archive:{outcome:archive},coverage_diagnostics:{outcome:compact}},{event_name:event}),!cancelled&&eligible&&archive==='success');
      }
    }
  });
  it('downloads and verifies only successful prior steps during intentional manual diagnostics', () => {
    assert.equal(upload.id, 'raw_coverage_upload');
    assert.equal(download.id, 'raw_coverage_download');
    assert.match(download.uses!, /^actions\/download-artifact@[a-f0-9]{40}$/u);
    assert.equal(download.with?.name, upload.with?.name);
    for(const [step,previous] of [[download,'raw_coverage_upload'],[verify,'raw_coverage_download']] as const){
      assert.match(step.if!, /^\$\{\{ !cancelled\(\) &&/u);
      const evaluate=new Function('cancelled','steps','github',`return (${step.if!.replace(/^\$\{\{\s*|\s*\}\}$/gu,'')});`);
      for(const event of ['pull_request','push','workflow_dispatch']) for(const cancelled of [false,true]) for(const outcome of ['success','failure','skipped','cancelled']){
        assert.strictEqual(evaluate(()=>cancelled,{[previous]:{outcome}},{event_name:event}),!cancelled&&event==='workflow_dispatch'&&outcome==='success');
      }
    }
  });
  for(const variant of ['complete','changed download','omitted auxiliary file']) it(`checks the actual package/extract/compare scripts with ${variant}`, () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ballin-raw-coverage-'));
    try {
      fs.mkdirSync(path.join(root,'coverage/tmp/nested'),{recursive:true});
      const files = {'coverage-123.json':Buffer.from('{"result":[]}\n'),'nested/source-map.bin':Buffer.from([0,1,127,255]),'.auxiliary':Buffer.from('retained'),'with space':Buffer.alloc(0)};
      for(const [file,bytes] of Object.entries(files))fs.writeFileSync(path.join(root,'coverage/tmp',file),bytes);
      if(variant==='omitted auxiliary file')fs.unlinkSync(path.join(root,'coverage/tmp/.auxiliary'));
      const roundtrip=path.join(root,'roundtrip');
      const env=testChildEnvironment({PATH:process.env.PATH,ROUNDTRIP_ROOT:roundtrip});
      const packed=spawnSync('/bin/bash',['-e','-o','pipefail','-c',pack.run],{cwd:root,env,encoding:'utf8'});
      assert.equal(packed.status,0,packed.stderr);
      fs.mkdirSync(path.join(roundtrip,'download'),{recursive:true});
      const downloaded=path.join(roundtrip,'download/coverage-raw.tar.gz');
      fs.copyFileSync(path.join(root,'coverage/coverage-raw.tar.gz'),downloaded);
      if(variant==='changed download')fs.appendFileSync(downloaded,'corrupt');
      if(variant==='omitted auxiliary file')fs.writeFileSync(path.join(root,'coverage/tmp/.auxiliary'),files['.auxiliary']);
      const checked=spawnSync('/bin/bash',['-e','-o','pipefail','-c',verify.run],{cwd:root,env,encoding:'utf8'});
      if(variant==='complete'){
        assert.equal(checked.status,0,checked.stdout+checked.stderr);
        assert.include(checked.stdout,'Raw coverage files:');
        for(const [file,bytes] of Object.entries(files))assert.deepEqual(fs.readFileSync(path.join(roundtrip,'extracted/tmp',file)),bytes);
      }else{
        assert.notEqual(checked.status,0,checked.stdout+checked.stderr);
        assert.equal(fs.existsSync(path.join(roundtrip,'extracted')),variant==='omitted auxiliary file');
      }
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
});
