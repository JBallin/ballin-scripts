const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runInNewContext } = require('node:vm');

const workflowDirectory = path.join(__dirname, '..', '.github', 'workflows');
const readWorkflow = (name: string): unknown => yaml.load(
  fs.readFileSync(path.join(workflowDirectory, name), 'utf8'),
);
const runtime = 'JBallin/claude-review-runtime/.github/workflows/';
const pin = 'b9a56eae9db8d11b67f5b6c5682c349146124711';
// Exact full-comment forms accepted by the selected Runtime. Actions contains()
// compares strings case-insensitively; no trimming or token splitting is added.
const manualCommands = ['/claude-review', '/claude-review opus'];
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  manualCommands.push(`/claude-review effort ${effort}`);
}
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  manualCommands.push(`/claude-review opus effort ${effort}`);
}
const reviewPermissions = {
  contents: 'read', 'pull-requests': 'write', checks: 'write', issues: 'write', 'id-token': 'write',
};
const reviewSecrets = { CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' };

// These are reviewed consumer contracts, not an Actions expression interpreter.
// Compare parsed YAML so quoting, comments and key order are immaterial, while
// every execution-bearing key and the complete critical script remain covered.
const contracts = {
  'claude-review.yml': {
    name: 'Claude Review',
    on: { pull_request: { types: ['opened', 'ready_for_review'] } },
    permissions: {},
    jobs: {
      review: {
        if: "github.event.pull_request.state == 'open' && "
          + '!github.event.pull_request.draft && '
          + "github.actor != 'dependabot[bot]' && "
          + 'github.event.pull_request.head.repo.full_name == github.repository',
        permissions: reviewPermissions,
        uses: `${runtime}claude-review.yml@${pin}`,
        secrets: reviewSecrets,
      },
    },
  },
  'claude.yml': {
    name: 'Manual Claude review',
    on: {
      issue_comment: { types: ['created'] },
      pull_request_review_comment: { types: ['created'] },
    },
    permissions: {},
    jobs: {
      eligibility: {
        if: `contains(fromJSON('${JSON.stringify(manualCommands)}'), github.event.comment.body) && `
          + "github.event.comment.user.type == 'User' && "
          + "github.event.sender.type == 'User' && "
          + 'contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association) && '
          + "(github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request)",
        'runs-on': 'ubuntu-26.04',
        'timeout-minutes': 2,
        permissions: { 'pull-requests': 'read' },
        outputs: { eligible: '${{ steps.eligibility.outputs.eligible }}' },
        steps: [{
          name: 'Install GNU timeout',
          run: [
            'sudo apt-get update',
            'sudo apt-get install --yes gnu-coreutils',
            'printf \'Runner image: %s (%s)\\n\' "${ImageOS:-unknown}" "${ImageVersion:-unknown}"',
            'cat /etc/os-release',
            'dpkg-query --show gnu-coreutils',
            'for tool in bash jq gh /usr/bin/gnutimeout; do',
            '  command -v "$tool"',
            '  "$tool" --version',
            'done',
            '',
          ].join('\n'),
        }, {
          name: 'Check PR eligibility',
          id: 'eligibility',
          env: {
            GNU_TIMEOUT: '/usr/bin/gnutimeout',
            GH_TOKEN: '${{ github.token }}',
            REPO: '${{ github.repository }}',
            PR_NUMBER: '${{ github.event.pull_request.number || github.event.issue.number }}',
          },
          run: [
            'set -euo pipefail',
            'timeout_version=$("$GNU_TIMEOUT" --version)',
            '[[ "$timeout_version" == *\'GNU coreutils\'* ]] || exit 1',
            'pr=$("$GNU_TIMEOUT" 30s gh api "repos/$REPO/pulls/$PR_NUMBER")',
            'eligible=$(printf \'%s\' "$pr" | jq -er --arg repo "$REPO" --argjson number "$PR_NUMBER" \'',
            '  if type != "object" then error("Invalid PR response")',
            '  elif (.number | type) != "number" or .number != $number',
            '    then error("Unexpected PR number")',
            '  else',
            '    .state == "open" and .draft == false and',
            '    .head.repo.full_name == $repo and .base.repo.full_name == $repo',
            "  end | tostring')",
            'printf \'eligible=%s\\n\' "$eligible" >> "$GITHUB_OUTPUT"',
            '',
          ].join('\n'),
        }],
      },
      review: {
        needs: 'eligibility',
        if: "needs.eligibility.outputs.eligible == 'true'",
        permissions: reviewPermissions,
        uses: `${runtime}claude.yml@${pin}`,
        secrets: reviewSecrets,
      },
    },
  },
  'claude-review-status.yml': {
    name: 'Refresh Claude Review status',
    on: {
      pull_request: { types: ['synchronize', 'edited'] },
      push: { branches: ['**'] },
    },
    permissions: {},
    jobs: {
      status: {
        if: "(github.event_name == 'push' && "
          + "startsWith(github.ref, 'refs/heads/') && github.event.deleted == false) || "
          + "(github.event_name == 'pull_request' && "
          + "github.event.pull_request.state == 'open' && "
          + 'github.event.pull_request.head.repo.full_name == github.repository && '
          + "(github.event.action == 'synchronize' || "
          + "(github.event.action == 'edited' && github.event.changes.base.ref.from != '')))",
        permissions: { contents: 'read', 'pull-requests': 'write', issues: 'write' },
        uses: `${runtime}claude-review-status.yml@${pin}`,
      },
    },
  },
};

describe('offline Claude caller contracts', () => {
  it('inventories runtime and credential references across every workflow', () => {
    const callers = fs.readdirSync(workflowDirectory)
      .filter((name: string) => /\.ya?ml$/u.test(name))
      .filter((name: string) => /claude-review-runtime|CLAUDE_CODE_OAUTH_TOKEN/iu.test(
        JSON.stringify(readWorkflow(name)),
      )).sort();
    assert.deepEqual(callers, Object.keys(contracts).sort());
  });

  for (const [name, expected] of Object.entries(contracts)) {
    it(`retains the complete approved ${name} consumer contract`, () => {
      assert.deepEqual(readWorkflow(name), expected);
    });
  }
});

describe('Claude status event routes', () => {
  const status = readWorkflow('claude-review-status.yml') as typeof contracts['claude-review-status.yml'];
  const repository = 'JBallin/ballin-scripts';
  const pullRequest = (overrides = {}) => ({
    state: 'open', draft: false, head: { repo: { full_name: repository } }, ...overrides,
  });

  // Exercise the parsed caller, including event subscription and its actual if.
  // The exact contract above bounds this to Boolean operators, string/Boolean
  // fixture values and startsWith; this is not a general Actions interpreter.
  const routesToStatus = (eventName: string, event: object, ref = ''): boolean => {
    const subscribed = eventName === 'push'
      ? status.on.push.branches.includes('**') && ref.startsWith('refs/heads/')
      : eventName === 'pull_request'
        && status.on.pull_request.types.includes((event as { action: string }).action);
    if (!subscribed) return false;
    const github = { event_name: eventName, repository, event, ref };
    const expression = status.jobs.status.if.replace(/github(?:\.[a-z_]+)+/gu, (key: string) => {
      let value: unknown = { github };
      for (const part of key.split('.')) {
        value = value && typeof value === 'object' ? Reflect.get(value, part) : undefined;
      }
      return JSON.stringify(value ?? '');
    });
    return Boolean(runInNewContext(expression, {
      startsWith: (value: string, prefix: string) => value.startsWith(prefix),
    }));
  };

  for (const ref of ['refs/heads/main', 'refs/heads/release', 'refs/heads/stack/parent']) {
    it(`forwards a target push to ${ref} without a PR payload`, () => {
      assert.isTrue(routesToStatus('push', { deleted: false }, ref));
    });
    it(`rejects deletion of ${ref}`, () => {
      assert.isFalse(routesToStatus('push', { deleted: true }, ref));
    });
  }

  for (const ref of ['refs/tags/v2', 'refs/pull/616/merge', '']) {
    it(`rejects a non-branch push (${ref || 'missing ref'})`, () => {
      assert.isFalse(routesToStatus('push', { deleted: false }, ref));
    });
  }

  for (const draft of [false, true]) {
    it(`retains same-repository head sync and base retarget (draft=${draft})`, () => {
      const pr = pullRequest({ draft });
      assert.isTrue(routesToStatus('pull_request', { action: 'synchronize', pull_request: pr }));
      assert.isTrue(routesToStatus('pull_request', {
        action: 'edited', pull_request: pr, changes: { base: { ref: { from: 'release' } } },
      }));
    });
  }

  for (const pr of [
    pullRequest({ state: 'closed' }),
    pullRequest({ head: { repo: { full_name: 'someone/fork' } } }),
    pullRequest({ head: { repo: null } }),
  ]) {
    it(`rejects ineligible PR head sync and base retarget: ${JSON.stringify(pr)}`, () => {
      assert.isFalse(routesToStatus('pull_request', { action: 'synchronize', pull_request: pr }));
      assert.isFalse(routesToStatus('pull_request', {
        action: 'edited', pull_request: pr, changes: { base: { ref: { from: 'main' } } },
      }));
    });
  }

  for (const changes of [undefined, { title: { from: 'old title' } }, { base: { ref: { from: '' } } }]) {
    it(`rejects an edit without a base retarget: ${JSON.stringify(changes)}`, () => {
      assert.isFalse(routesToStatus('pull_request', { action: 'edited', pull_request: pullRequest(), changes }));
    });
  }

  for (const action of ['opened', 'ready_for_review', 'closed']) {
    it(`leaves ${action} outside status event handling`, () => {
      assert.isFalse(routesToStatus('pull_request', { action, pull_request: pullRequest() }));
    });
  }

  for (const eventName of ['workflow_dispatch', 'issue_comment', 'pull_request_target']) {
    it(`rejects unrelated ${eventName} events`, () => {
      assert.isFalse(routesToStatus(eventName, { deleted: false }, 'refs/heads/main'));
    });
  }
});
