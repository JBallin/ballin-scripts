const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflowDirectory = path.join(__dirname, '..', '.github', 'workflows');
const readWorkflow = (name: string): unknown => yaml.load(
  fs.readFileSync(path.join(workflowDirectory, name), 'utf8'),
);
const runtime = 'JBallin/claude-review-runtime/.github/workflows/';
const pin = 'a0f81933a3272c362ed40f99020c59defb410c86';
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
        if: "github.event.comment.body == '/claude-review' && "
          + "github.event.comment.user.type == 'User' && "
          + "github.event.sender.type == 'User' && "
          + 'contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association) && '
          + "(github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request)",
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 2,
        permissions: { 'pull-requests': 'read' },
        outputs: { eligible: '${{ steps.eligibility.outputs.eligible }}' },
        steps: [{
          name: 'Check PR eligibility',
          id: 'eligibility',
          env: {
            GH_TOKEN: '${{ github.token }}',
            REPO: '${{ github.repository }}',
            PR_NUMBER: '${{ github.event.pull_request.number || github.event.issue.number }}',
          },
          run: [
            'set -euo pipefail',
            'pr=$(timeout 30s gh api "repos/$REPO/pulls/$PR_NUMBER")',
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
    on: { pull_request: { types: ['synchronize', 'edited'] } },
    permissions: {},
    jobs: {
      status: {
        if: "github.event.pull_request.state == 'open' && "
          + 'github.event.pull_request.head.repo.full_name == github.repository && '
          + "(github.event.action == 'synchronize' || "
          + "(github.event.action == 'edited' && github.event.changes.base.ref.from != ''))",
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
