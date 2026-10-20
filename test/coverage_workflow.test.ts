const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8',
)) as { jobs: { test: { steps: { name: string; if?: string }[] } } };

const conditions = [
  ['Capture coverage comparison evidence', 'capture'],
  ['Upload raw V8 coverage evidence', 'raw'],
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
