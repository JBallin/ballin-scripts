const fs = require('fs');
const path = require('path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'codeql.yml'), 'utf8');

describe('staged CodeQL workflow', () => {
  it('remains manual-only until the separately approved activation', () => {
    const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/mu)?.[1].trim();
    assert.equal(triggers, 'workflow_dispatch:');
  });

  it('preserves both language analyses, required job names, and result categories', () => {
    assert.match(workflow, /^    name: Analyze \(\$\{\{ matrix\.language \}\}\)\s*$/mu);
    assert.match(workflow, /^        language: \[actions, javascript-typescript\]\s*$/mu);
    assert.match(workflow, /^      fail-fast: false\s*$/mu);
    assert.match(workflow, /^          languages: \$\{\{ matrix\.language \}\}\s*$/mu);
    assert.match(workflow, /^          build-mode: none\s*$/mu);
    assert.match(workflow, /^          category: \/language:\$\{\{ matrix\.language \}\}\s*$/mu);
    assert.notMatch(workflow, /^\s+(?:queries|packs|config|config-file|paths|paths-ignore):/mu);
  });

  it('uses only pinned checkout and CodeQL actions, without executing repository scripts', () => {
    const actions = [...workflow.matchAll(/^\s+uses: (\S+)@(\S+)/gmu)];
    assert.deepEqual(actions.map((match) => match[1]), [
      'actions/checkout', 'github/codeql-action/init', 'github/codeql-action/analyze',
    ]);
    actions.forEach((match) => assert.match(match[2], /^[a-f\d]{40}$/u));
    assert.equal(actions[1][2], actions[2][2], 'init and analyze must use the same revision');
    assert.notMatch(workflow, /^\s+(?:run|env|container|services):|secrets\./mu);
  });

  it('limits permissions and uses hosted runners without persisting credentials', () => {
    const permissions = [...workflow.matchAll(/^\s+([a-z-]+): (read|write)\s*$/gmu)]
      .map((match) => `${match[1]}: ${match[2]}`);
    assert.deepEqual(permissions, ['contents: read', 'contents: read', 'security-events: write']);
    assert.match(workflow, /^    runs-on: ubuntu-latest\s*$/mu);
    assert.match(workflow, /^          persist-credentials: false\s*$/mu);
  });
});
