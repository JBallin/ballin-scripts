const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const workflow = yaml.load(fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8',
)) as { jobs: { test: { steps: { name: string; id?: string; if?: string; run?: string; with?: Record<string, unknown> }[] } } };

const conditions = [
  ['Capture coverage comparison evidence', 'capture'],
  ['Package raw V8 coverage evidence', 'raw'],
] as const;

describe('coverage evidence workflow conditions', () => {
  for (const [name, kind] of conditions) {
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
                  || (kind === 'capture' && event === 'workflow_dispatch' && outcome === 'success'));
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
  it('uploads only a completed archive after failed coverage, independently of compact reports', () => {
    assert.equal(pack.id, 'raw_coverage_archive');
    assert.equal(upload.with?.path, 'coverage/coverage-raw.tar.gz');
    assert.equal(upload.with?.['compression-level'], 0); assert.equal(upload.with?.['retention-days'], 7);
    assert.equal(upload.with?.['if-no-files-found'], 'error');
    const evaluate = new Function('cancelled', 'steps', `return (${upload.if!.replace(/^\$\{\{\s*|\s*\}\}$/gu, '')});`);
    for (const cancelled of [false,true]) for (const coverage of ['success','failure','skipped','cancelled']) {
      for (const archive of ['success','failure','skipped','cancelled']) for (const compact of ['success','failure','skipped']) {
        assert.strictEqual(evaluate(()=>cancelled,{coverage:{outcome:coverage},raw_coverage_archive:{outcome:archive},coverage_diagnostics:{outcome:compact}}),!cancelled&&coverage==='failure'&&archive==='success');
      }
    }
  });
  it('round-trips the complete raw directory, including nested, hidden and binary auxiliary files', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ballin-raw-coverage-'));
    try {
      fs.mkdirSync(path.join(root,'coverage/tmp/nested'),{recursive:true});
      const files = {'coverage-123.json':Buffer.from('{"result":[]}\n'),'nested/source-map.bin':Buffer.from([0,1,127,255]),'.auxiliary':Buffer.from('retained')};
      for(const [file,bytes] of Object.entries(files))fs.writeFileSync(path.join(root,'coverage/tmp',file),bytes);
      const env=testChildEnvironment({PATH:process.env.PATH});
      const packed=spawnSync('/bin/bash',['-e','-o','pipefail','-c',pack.run],{cwd:root,env,encoding:'utf8'});
      assert.equal(packed.status,0,packed.stderr);
      const extraction=path.join(root,'extracted');fs.mkdirSync(extraction);
      const unpacked=spawnSync('tar',['-xzf',path.join(root,'coverage/coverage-raw.tar.gz'),'-C',extraction],{env,encoding:'utf8'});
      assert.equal(unpacked.status,0,unpacked.stderr);
      for(const [file,bytes] of Object.entries(files))assert.deepEqual(fs.readFileSync(path.join(extraction,'tmp',file)),bytes);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
});
