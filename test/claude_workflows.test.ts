const fs = require('fs');
const path = require('path');
const vm = require('vm');

const readWorkflow = (name: string): string => fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', name), 'utf8',
);
const automatic = readWorkflow('claude-review.yml');
const manual = readWorkflow('claude.yml');
const status = readWorkflow('claude-review-status.yml');
const jobs = (workflow: string): string => {
  const result = workflow.match(/^jobs:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/mu);
  assert.exists(result, 'missing jobs map');
  for (const line of result![1].split('\n').filter((line: string) => /^  \S/u.test(line))) {
    assert.match(line, /^  [\w-]+:$/u, 'unsupported direct-child job key: use the canonical unquoted form');
  }
  return result![1];
};
const job = (workflow: string, name: string): string => {
  const result = jobs(workflow).match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'mu'));
  assert.exists(result, `missing job ${name}`);
  return result![1];
};
const predicateExpression = (predicate: string): string => {
  // Match one token at the current offset; never backtrack across prior tokens.
  const tokenPattern = /\s+|"[^"\\]*"|\.[a-z_]+(?:\.[a-z_]+)*|\$repo\b|\band\b|==|true\b|false\b/gyu;
  let expression = '';
  for (let offset = 0; offset < predicate.length;) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(predicate);
    assert.exists(match, 'unsupported preflight predicate: extend the fixture coverage deliberately');
    const token = match![0];
    expression += token.startsWith('.') ? `field(response, ${JSON.stringify(token.slice(1))})`
      : ({ $repo: 'repo', and: '&&', '==': '===' } as Record<string, string>)[token] ?? token;
    offset = tokenPattern.lastIndex;
  }
  return expression;
};
const condition = (source: string): string => {
  const result = source.match(/^    if: >-\n((?:      .+\n)+)/mu);
  assert.exists(result, 'missing job condition');
  return result![1].trim();
};

// These callers use only boolean operators, property reads, contains and fromJSON.
// Evaluate that subset against fixtures, folding strings like Actions comparisons.
// This is consumer coverage, not a general GitHub Actions expression interpreter.
const eligible = (source: string, context: object): boolean => {
  const folded = JSON.parse(JSON.stringify(context, (_key, value: unknown) => (
    typeof value === 'string' ? value.toLowerCase() : value
  )));
  const expression = condition(source).replace(/'[^']*'/gu, (literal: string) => literal.toLowerCase());
  return Boolean(vm.runInNewContext(expression, {
    ...folded,
    fromJSON: JSON.parse,
    contains: (values: string[], value: string) => values.includes(value),
  }, { timeout: 100 }));
};
const pr = () => ({
  number: 42, state: 'open', draft: false,
  head: { repo: { full_name: 'JBallin/ballin-scripts' } },
  base: { repo: { full_name: 'JBallin/ballin-scripts' } },
});
const github = () => ({
  repository: 'JBallin/ballin-scripts', actor: 'jballin', event_name: 'issue_comment',
  event: {
    action: 'synchronize', pull_request: pr(), changes: { base: { ref: { from: '' } } },
    issue: { number: 42, pull_request: { url: 'fixture' } as object | null },
    comment: { body: '/claude-review', user: { type: 'User' }, author_association: 'OWNER' },
    sender: { type: 'User' },
  },
});

describe('offline Claude caller contracts', () => {
  it('rejects unsupported predicate syntax after long whitespace and field tokens', () => {
    for (const prefix of [' '.repeat(100_000), `.field${'.field'.repeat(10_000)}`]) {
      assert.throws(() => predicateExpression(`${prefix}!`), 'unsupported preflight predicate');
    }
  });

  it('distinguishes event triggers from jobs with the same names', () => {
    for (const name of ['pull_request', 'issue_comment', 'pull_request_review_comment']) {
      const workflow = `on:\n  ${name}:\n    types: [created]\njobs:\n  ${name}:\n    permissions:\n      contents: write\n`;
      assert.deepEqual([...jobs(workflow).matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]), [name]);
      assert.match(job(workflow, name), /contents: write/u);
    }
  });

  it('fails closed on quoted direct-child job keys', () => {
    for (const key of ["'audit'", '"audit"']) {
      assert.throws(() => jobs(`jobs:\n  ${key}:\n    runs-on: ubuntu-latest\n  review:\n`),
        'unsupported direct-child job key');
    }
  });

  it('selects only the intended automatic, manual and model-free refresh events', () => {
    const triggers = (workflow: string) => workflow.match(/^on:\n([\s\S]*?)(?=^\S)/mu)![1].trim();
    assert.equal(triggers(automatic), 'pull_request:\n    types: [opened, ready_for_review]');
    assert.equal(triggers(manual), 'issue_comment:\n    types: [created]\n  pull_request_review_comment:\n    types: [created]');
    assert.equal(triggers(status), 'pull_request:\n    types: [synchronize, edited]');
  });

  it('accepts an open same-repository automatic review and excludes drafts, forks and Dependabot', () => {
    const source = job(automatic, 'review');
    assert.isTrue(eligible(source, { github: github() }));
    const negatives = [
      (g: ReturnType<typeof github>) => { g.event.pull_request.state = 'closed'; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.draft = true; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.head.repo.full_name = 'contributor/fork'; },
      (g: ReturnType<typeof github>) => { g.actor = 'dependabot[bot]'; },
    ];
    for (const change of negatives) {
      const g = github();
      change(g);
      assert.isFalse(eligible(source, { github: g }), change.toString());
    }
  });

  it('requires an entire manual command from trusted humans on a PR comment', () => {
    const source = job(manual, 'eligibility');
    for (const eventName of ['issue_comment', 'pull_request_review_comment']) {
      for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        const g = github();
        g.event_name = eventName;
        g.event.comment.author_association = association;
        if (eventName === 'pull_request_review_comment') g.event.issue.pull_request = null;
        assert.isTrue(eligible(source, { github: g }));
      }
    }
    for (const body of ['/claude-review please', ' /claude-review', '/claude-review\n', 'text\n/claude-review', '/claude-review-extra', '']) {
      const g = github();
      g.event.comment.body = body;
      assert.isFalse(eligible(source, { github: g }), JSON.stringify(body));
    }
    for (const association of ['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR']) {
      const g = github();
      g.event.comment.author_association = association;
      assert.isFalse(eligible(source, { github: g }), association);
    }
    for (const field of ['comment', 'sender'] as const) {
      const g = github();
      if (field === 'comment') g.event.comment.user.type = 'Bot';
      else g.event.sender.type = 'Bot';
      assert.isFalse(eligible(source, { github: g }), field);
    }
    const issueComment = github();
    issueComment.event.issue.pull_request = null;
    assert.isFalse(eligible(source, { github: issueComment }));
  });

  it('protects the manual preflight response guards, eligibility predicate and shell wiring', () => {
    const eligibility = job(manual, 'eligibility');
    assert.match(eligibility, /eligible: \$\{\{ steps\.eligibility\.outputs\.eligible \}\}/u);
    const step = eligibility.match(/^      - name: [^\n]+\n        id: eligibility\n([\s\S]*?)(?=^      - |$(?![\s\S]))/mu);
    assert.exists(step, 'the preflight producer must retain its eligibility step ID');
    const source = step![1];
    assert.match(source, /^          GH_TOKEN: \$\{\{ github\.token \}\}$/mu);
    assert.match(source, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}/u);
    assert.match(source, /REPO: \$\{\{ github\.repository \}\}/u);
    assert.match(source, /^          set -euo pipefail$/mu);
    // Bind the fetched response, evaluated filter and emitted result together.
    // An unrelated filter or an unconditional eligible=true must not substitute.
    const pipeline = source.match(/^          pr=\$\(timeout 30s gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER"\)\n          eligible=\$\(printf '%s' "\$pr" \| jq -er --arg repo "\$REPO" --argjson number "\$PR_NUMBER" '\n([\s\S]*?)'\)\n          printf 'eligible=%s\\n' "\$eligible" >> "\$GITHUB_OUTPUT"\n/mu);
    assert.exists(pipeline, 'the jq result must be assigned to eligible and immediately emitted');
    assert.equal([...eligibility.matchAll(/^\s+eligible=/gmu)].length, 1, 'eligibility must not be overwritten');
    assert.equal([...eligibility.matchAll(/\bGITHUB_OUTPUT\b/gu)].length, 1, 'only the canonical checked result may be emitted');
    const filter = pipeline![1].trim();
    assert.notMatch(filter, /#/u, 'comments are unsupported in this bounded preflight filter');
    assert.deepEqual(filter.split('\n').slice(0, 4).map((line: string) => line.trim()), [
      'if type != "object" then error("Invalid PR response")',
      'elif (.number | type) != "number" or .number != $number',
      'then error("Unexpected PR number")',
      'else',
    ], 'the active response guards must precede the eligibility predicate');
    assert.equal(filter.split('\n').at(-1)?.trim(), 'end | tostring');

    // Evaluate the actual predicate's field equalities and conjunctions in Node.
    // Response/error guards and shell wiring above are structural assertions;
    // these fixtures do not execute Bash or validate the jq language/runtime.
    const predicate = filter.match(/\belse\s+([\s\S]*?)\s+end\s*\|\s*tostring/u)![1];
    const expression = predicateExpression(predicate);
    const evaluate = (response: object): boolean => Boolean(vm.runInNewContext(expression, {
      response, repo: 'JBallin/ballin-scripts',
      field: (input: unknown, name: string): unknown => name.split('.').reduce<unknown>((value, key) => (
        value !== null && typeof value === 'object' && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key] ?? null : null
      ), input),
    }, { timeout: 100 }));
    assert.isTrue(evaluate(pr()));
    for (const change of [
      (p: ReturnType<typeof pr>) => { p.state = 'closed'; },
      (p: ReturnType<typeof pr>) => { p.draft = true; },
      (p: ReturnType<typeof pr>) => { p.head.repo.full_name = 'contributor/fork'; },
      (p: ReturnType<typeof pr>) => { p.base.repo.full_name = 'other/repo'; },
    ]) {
      const p = pr();
      change(p);
      assert.isFalse(evaluate(p), change.toString());
    }
    assert.isFalse(evaluate({ number: 42 }), 'missing eligibility fields fail closed');
  });

  it('requires a successful preflight before invoking the manual runtime', () => {
    const source = job(manual, 'review');
    assert.match(source, /^    needs: eligibility$/mu);
    assert.isTrue(eligible(source, { needs: { eligibility: { outputs: { eligible: 'true' } } } }));
    for (const value of ['false', '', 'unexpected']) {
      assert.isFalse(eligible(source, { needs: { eligibility: { outputs: { eligible: value } } } }));
    }
  });

  it('refreshes on pushes and base retargets, excluding other edits, forks and closed PRs', () => {
    const source = job(status, 'status');
    assert.isTrue(eligible(source, { github: github() }));
    const retarget = github();
    retarget.event.action = 'edited';
    retarget.event.changes.base.ref.from = 'main';
    assert.isTrue(eligible(source, { github: retarget }));
    for (const change of [
      (g: ReturnType<typeof github>) => { g.event.action = 'edited'; },
      (g: ReturnType<typeof github>) => { g.event.action = 'opened'; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.state = 'closed'; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.head.repo.full_name = 'contributor/fork'; },
    ]) {
      const g = github();
      change(g);
      assert.isFalse(eligible(source, { github: g }), change.toString());
    }
  });

  it('keeps permissions scoped to jobs and the Claude credential scoped to review calls', () => {
    const reviewPermissions = ['contents: read', 'pull-requests: write', 'checks: write', 'issues: write', 'id-token: write'];
    for (const [workflow, names, permissions] of [
      [automatic, ['review'], [reviewPermissions]],
      [manual, ['eligibility', 'review'], [['pull-requests: read'], reviewPermissions]],
      [status, ['status'], [['contents: read', 'pull-requests: write', 'issues: write']]],
    ] as const) {
      assert.match(workflow, /^permissions: \{\}$/mu);
      assert.notMatch(workflow, /\bsecrets\s*\[/u, 'indexed secrets access is unsupported; retain the approved dot reference');
      assert.deepEqual([...jobs(workflow).matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]), [...names]);
      names.forEach((name, index) => {
        const source = job(workflow, name);
        const permissionBlock = source.match(/^    permissions:\n((?:      .+\n)+)/mu)![1];
        assert.deepEqual(permissionBlock.trim().split('\n').map((line: string) => line.trim()), [...permissions[index]]);
        if (name === 'review') {
          assert.match(source, /^    secrets:\n      CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}$/mu);
          assert.equal([...source.matchAll(/secrets\./gu)].length, 1);
          assert.notMatch(source, /^    (?:steps|env|with):/mu);
        } else {
          assert.notMatch(source, /secrets:|secrets\.|CLAUDE_CODE_OAUTH_TOKEN/u);
        }
      });
      assert.notMatch(workflow, /secrets: inherit|write-all/u);
      assert.equal([...workflow.matchAll(/secrets\./gu)].length, workflow === status ? 0 : 1);
    }
    assert.notMatch(status, /^\s+(?:steps|env|with):/mu);
  });

  it('uses the reviewed immutable revision consistently for the three runtime entry points', () => {
    const pin = '9acfdda9358a9eff22bd4a133135c3fbb2b8f512';
    for (const [workflow, entry] of [[automatic, 'claude-review.yml'], [manual, 'claude.yml'], [status, 'claude-review-status.yml']]) {
      const calls = [...workflow.matchAll(/^\s+uses: (\S+)$/gmu)].map((match) => match[1]);
      assert.deepEqual(calls, [`JBallin/claude-review-runtime/.github/workflows/${entry}@${pin}`]);
    }
  });
});
