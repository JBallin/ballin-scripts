const fs = require('fs');
const path = require('path');
const vm = require('vm');

const readWorkflow = (name: string): string => fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', name), 'utf8',
);
const automatic = readWorkflow('claude-review.yml');
const manual = readWorkflow('claude.yml');
const status = readWorkflow('claude-review-status.yml');
const directKeys = (source: string, indentation: string): string[] => source.split('\n')
  .filter((line: string) => line.startsWith(indentation) && /^\S/u.test(line.slice(indentation.length))
    && !line.slice(indentation.length).startsWith('#'))
  .map((line: string) => {
    const key = line.slice(indentation.length).match(/^([\w-]+):(?: .*)?$/u);
    assert.exists(key, 'unsupported direct key: retain the canonical unquoted form');
    return key![1];
  });
const rootMap = (workflow: string, name: string): string => {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`${name}:`);
  assert.isAtLeast(start, 0, `missing canonical ${name} map`);
  const end = lines.findIndex((line: string, index: number) => index > start && /^[\w-]+:/u.test(line));
  // Comments do not close a YAML map; retain all content until the next root key.
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
};
const jobs = (workflow: string): string => {
  const source = rootMap(workflow, 'jobs');
  for (const line of source.split('\n').filter((line: string) => /^  \S/u.test(line))) {
    assert.match(line, /^  [\w-]+:$/u, 'unsupported direct-child job key: use the canonical unquoted form');
  }
  return source;
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
const section = (source: string, header: string): string[] => {
  const lines = source.split('\n');
  const start = lines.indexOf(`    ${header}`);
  assert.isAtLeast(start, 0, `missing canonical ${header} section`);
  const end = lines.findIndex((line: string, index: number) => index > start && /^    [\w-]+:/u.test(line));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end);
  // A final newline is not a scalar/map entry; internal blank lines are retained.
  if (end === -1 && body.at(-1) === '') body.pop();
  assert.isNotEmpty(body, `empty ${header} section`);
  for (const line of body) {
    assert.match(line, /^      \S/u, `unsupported line in complete ${header} section`);
    assert.notMatch(line, /^      #/u, `unsupported comment in complete ${header} section`);
  }
  return body.map((line: string) => line.slice(6));
};
const condition = (source: string): string => section(source, 'if: >-').join('\n');

const conditionExpression = (expression: string): string => {
  const tokenPattern = /\s+|'[^'\\]*'|(?:github|needs)(?:\.[a-z_]+)+\b|contains\b|fromJSON\b|true\b|false\b|==|!=|&&|\|\||!|[(),]/gyu;
  const tokens: string[] = [];
  for (let offset = 0; offset < expression.length;) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(expression);
    assert.exists(match, 'unsupported caller condition syntax: extend the fixture coverage deliberately');
    if (match![0].trim()) tokens.push(match![0]);
    offset = tokenPattern.lastIndex;
  }
  const argumentsStack: { name: string; commas: number }[] = [];
  tokens.forEach((token, index) => {
    if (['contains', 'fromJSON'].includes(token)) {
      assert.equal(tokens[index + 1], '(', 'unsupported caller condition syntax: functions must use call syntax');
    }
    if (token === '(' && index > 0 && !['!', '&&', '||', '(', ',', 'contains', 'fromJSON'].includes(tokens[index - 1])) {
      assert.fail('unsupported caller condition syntax: only contains and fromJSON calls are supported');
    }
    if (token === '(') argumentsStack.push({ name: tokens[index - 1] ?? '', commas: 0 });
    if (token === ')') argumentsStack.pop();
    if (token === ',') {
      const call = argumentsStack.at(-1);
      assert.isTrue(call?.name === 'contains' && call.commas === 0,
        'unsupported caller condition syntax: commas must separate the two contains arguments');
      call!.commas += 1;
    }
  });
  return expression;
};

// These callers use only boolean operators, property reads, contains and fromJSON.
// Evaluate that subset against fixtures, folding strings like Actions comparisons.
// This is consumer coverage, not a general GitHub Actions expression interpreter.
const eligible = (source: string, context: object): boolean => {
  const folded = JSON.parse(JSON.stringify(context, (_key, value: unknown) => (
    typeof value === 'string' ? value.toLowerCase() : value
  )));
  const expression = conditionExpression(condition(source)).replace(/'[^']*'/gu, (literal: string) => literal.toLowerCase());
  return Boolean(vm.runInNewContext(expression, {
    ...folded,
    fromJSON: JSON.parse,
    contains: (values: string[], value: string) => values.includes(value),
  }, { timeout: 100 }));
};
const pr = () => ({
  number: 42, state: 'open', draft: false,
  head: { ref: 'feature-review', repo: { full_name: 'JBallin/ballin-scripts' } },
  base: { ref: 'main', repo: { full_name: 'JBallin/ballin-scripts' } },
});
const github = (eventName = 'pull_request', action = 'synchronize') => ({
  repository: 'JBallin/ballin-scripts', actor: 'jballin', event_name: eventName,
  event: {
    action, pull_request: pr(),
    ...(action === 'edited' ? { changes: { base: { ref: { from: '' } } } } : {}),
  },
});
const commentGithub = (eventName = 'issue_comment') => ({
  repository: 'JBallin/ballin-scripts', actor: 'jballin', event_name: eventName,
  event: {
    action: 'created',
    ...(eventName === 'issue_comment'
      ? { issue: { number: 42, pull_request: { url: 'fixture' } as object | null } }
      : { pull_request: pr() }),
    comment: { body: '/claude-review', user: { type: 'User' }, author_association: 'OWNER' },
    sender: { type: 'User' },
  },
});

describe('offline Claude caller contracts', () => {
  it('rejects JavaScript-only condition syntax before evaluating fixtures', () => {
    for (const expression of [
      "github.actor === 'jballin'", "github.actor !== 'dependabot[bot]'",
      "github.actor.includes('ballin')", "github.actor ? true : false",
      "(true, github.actor == 'jballin')", "true, github.actor == 'jballin'",
      "contains((true, github.actor), 'jballin')", "fromJSON('true', 'false')",
      'true && contains', 'true && fromJSON',
    ]) {
      assert.throws(() => conditionExpression(expression), 'unsupported caller condition syntax');
    }
  });
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
    const triggers = (workflow: string) => rootMap(workflow, 'on').trim();
    assert.equal(triggers(automatic), 'pull_request:\n    types: [opened, ready_for_review]');
    assert.equal(triggers(manual), 'issue_comment:\n    types: [created]\n  pull_request_review_comment:\n    types: [created]');
    assert.equal(triggers(status), 'pull_request:\n    types: [synchronize, edited]');
  });

  it('accepts an open same-repository automatic review and excludes drafts, forks and Dependabot', () => {
    const source = job(automatic, 'review');
    const negatives = [
      (g: ReturnType<typeof github>) => { g.event.pull_request.state = 'closed'; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.draft = true; },
      (g: ReturnType<typeof github>) => { g.event.pull_request.head.repo.full_name = 'contributor/fork'; },
      (g: ReturnType<typeof github>) => { g.actor = 'dependabot[bot]'; },
    ];
    for (const action of ['opened', 'ready_for_review']) {
      for (const actor of ['jballin', 'human-collaborator']) {
        const g = github('pull_request', action);
        g.actor = actor;
        assert.isTrue(eligible(source, { github: g }), `${action}: ${actor}`);
      }
      for (const change of negatives) {
        const g = github('pull_request', action);
        change(g);
        assert.isFalse(eligible(source, { github: g }), `${action}: ${change.toString()}`);
      }
    }
  });

  it('requires an entire manual command from trusted humans on a PR comment', () => {
    const source = job(manual, 'eligibility');
    for (const eventName of ['issue_comment', 'pull_request_review_comment']) {
      const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'];
      for (const body of ['/claude-review please', ' /claude-review', '/claude-review\n', 'text\n/claude-review', '/claude-review-extra', '']) {
        const g = commentGithub(eventName);
        g.event.comment.body = body;
        assert.isFalse(eligible(source, { github: g }), `${eventName}: ${JSON.stringify(body)}`);
      }
      for (const association of [...trusted, 'NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR']) {
        for (const commenter of ['User', 'Bot']) {
          for (const sender of ['User', 'Bot']) {
            const g = commentGithub(eventName);
            g.event.comment.author_association = association;
            g.event.comment.user.type = commenter;
            g.event.sender.type = sender;
            assert.equal(eligible(source, { github: g }), trusted.includes(association) && commenter === 'User' && sender === 'User',
              `${eventName}: ${association}, commenter ${commenter}, sender ${sender}`);
          }
        }
      }
    }
    const issueComment = commentGithub();
    if (!('issue' in issueComment.event)) throw new Error('missing issue_comment fixture issue');
    issueComment.event.issue.pull_request = null;
    assert.isFalse(eligible(source, { github: issueComment }));
  });

  it('protects the manual preflight response guards, eligibility predicate and shell wiring', () => {
    const eligibility = job(manual, 'eligibility');
    assert.match(eligibility, /^    runs-on: ubuntu-latest$/mu);
    assert.match(eligibility, /^    outputs:\n      eligible: \$\{\{ steps\.eligibility\.outputs\.eligible \}\}\n(?=    [\w-]+:)/mu);
    assert.equal([...eligibility.matchAll(/^    outputs:/gmu)].length, 1, 'only one canonical outputs map is supported');
    assert.notMatch(eligibility, /^    ['"]outputs['"]:/mu, 'quoted outputs keys are unsupported');
    const steps = eligibility.match(/^    steps:\n([\s\S]*)$/mu);
    assert.exists(steps, 'missing canonical preflight steps');
    const source = steps![1].trimEnd();
    const capturedFilter = source.match(/jq -er --arg repo "\$REPO" --argjson number "\$PR_NUMBER" '\n([\s\S]*?)'\)/u);
    assert.exists(capturedFilter, 'missing preflight filter');
    const capturedPredicate = capturedFilter![1].match(/^            else\n([\s\S]*?)\n            end \| tostring$/mu);
    assert.exists(capturedPredicate, 'missing canonical eligibility predicate');
    const predicate = capturedPredicate![1];
    const filter = [
      '            if type != "object" then error("Invalid PR response")',
      '            elif (.number | type) != "number" or .number != $number',
      '              then error("Unexpected PR number")',
      '            else', predicate, '            end | tostring',
    ].join('\n');
    // Exact critical-block protection plus representative predicate behavior.
    // This is not execution of Bash/jq or proof about arbitrary source forms.
    const expected = [
      '      - name: Check PR eligibility',
      '        id: eligibility',
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '          REPO: ${{ github.repository }}',
      '          PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number }}',
      '        run: |',
      '          set -euo pipefail',
      '          pr=$(timeout 30s gh api "repos/$REPO/pulls/$PR_NUMBER")',
      "          eligible=$(printf '%s' \"$pr\" | jq -er --arg repo \"$REPO\" --argjson number \"$PR_NUMBER\" '",
      `${filter}')`,
      "          printf 'eligible=%s\\n' \"$eligible\" >> \"$GITHUB_OUTPUT\"",
    ].join('\n');
    assert.equal(source, expected, 'preflight steps must retain the complete canonical critical block');
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
    const retargets = ['main', 'release'].map((priorBase) => {
      const g = github('pull_request', 'edited');
      if (!g.event.changes) throw new Error('missing edited fixture changes');
      g.event.changes.base.ref.from = priorBase;
      return g;
    });
    for (const context of [github('pull_request', 'synchronize'), ...retargets]) {
      assert.isTrue(eligible(source, { github: context }));
      for (const change of [
        (g: ReturnType<typeof github>) => { g.event.pull_request.state = 'closed'; },
        (g: ReturnType<typeof github>) => { g.event.pull_request.head.repo.full_name = 'contributor/fork'; },
      ]) {
        const g = JSON.parse(JSON.stringify(context));
        change(g);
        assert.isFalse(eligible(source, { github: g }), `${context.event.action}: ${change.toString()}`);
      }
    }
    // An edited event without a base retarget remains ineligible.
    for (const action of ['edited', 'opened']) {
      const g = github('pull_request', action);
      assert.isFalse(eligible(source, { github: g }), action);
    }
  });

  it('keeps permissions scoped to jobs and the Claude credential scoped to review calls', () => {
    const reviewPermissions = ['contents: read', 'pull-requests: write', 'checks: write', 'issues: write', 'id-token: write'];
    for (const [workflow, names, permissions, keys] of [
      [automatic, ['review'], [reviewPermissions], [['if', 'permissions', 'uses', 'secrets']]],
      [manual, ['eligibility', 'review'], [['pull-requests: read'], reviewPermissions], [
        ['if', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps'],
        ['needs', 'if', 'permissions', 'uses', 'secrets'],
      ]],
      [status, ['status'], [['contents: read', 'pull-requests: write', 'issues: write']], [['if', 'permissions', 'uses']]],
    ] as const) {
      assert.deepEqual(directKeys(workflow, ''), ['name', 'on', 'permissions', 'jobs'], 'unsupported workflow key');
      assert.match(workflow, /^permissions: \{\}$/mu);
      assert.notMatch(workflow, /\bsecrets\s*\[/u, 'indexed secrets access is unsupported; retain the approved dot reference');
      assert.deepEqual([...jobs(workflow).matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]), [...names]);
      names.forEach((name, index) => {
        const source = job(workflow, name);
        assert.deepEqual(directKeys(source, '    '), [...keys[index]], `unsupported keys in ${name}`);
        assert.deepEqual(section(source, 'permissions:'), [...permissions[index]]);
        if (name === 'review') {
          assert.deepEqual(section(source, 'secrets:'), ['CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}']);
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
    const pin = '79f70e54cf322f67e466b77403df7b2c22496ada';
    for (const [workflow, name, entry] of [[automatic, 'review', 'claude-review.yml'], [manual, 'review', 'claude.yml'], [status, 'status', 'claude-review-status.yml']]) {
      const source = job(workflow, name);
      assert.notMatch(source, /^    ['"]uses['"]:/mu, 'quoted invocation keys are unsupported');
      const calls = [...source.matchAll(/^    uses: (\S+)$/gmu)].map((match) => match[1]);
      assert.deepEqual(calls, [`JBallin/claude-review-runtime/.github/workflows/${entry}@${pin}`]);
      // The bound invocation must also be the workflow's only uses call.
      const allCalls = [...workflow.matchAll(/^\s+uses: (\S+)$/gmu)].map((match) => match[1]);
      assert.deepEqual(allCalls, calls, 'unexpected workflow-level or step uses call');
    }
  });
});
