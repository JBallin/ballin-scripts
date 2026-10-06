# Code scanning

*Maintainer guide to Advanced CodeQL coverage, verification, and recovery.*

## Advanced setup

The checked-in [workflow](../.github/workflows/codeql.yml) runs Advanced CodeQL
for ordinary pull requests to `main` (`opened`, `reopened`, and `synchronize`),
pushes to `main`, manual dispatch, and the weekly schedule `23 4 * * 2` (Tuesday at 04:23
UTC). Scheduled scans run on the default branch. There are no path filters or
fork exclusions to suppress a required scan.

The scan covers Actions and JavaScript/TypeScript with `build-mode: none`, the
default query suite, no custom queries, model packs, or additional threat models,
and categories `/language:actions` and `/language:javascript-typescript`. The
workflow pins checkout v6 and CodeQL v4 revisions. Review action updates
deliberately; adding languages or queries is a separate coverage change.

Keep default setup disabled while Advanced CodeQL owns scanning.
[GitHub rejects Advanced CodeQL uploads while default setup is enabled](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/troubleshoot-sarif-uploads/default-setup-enabled).
Settings changes require explicit owner approval. Preserve required checks,
branch protections, alert severity settings, and the contributor approval policy;
do not use an administrator bypass to work around a scan failure. `main` is the
only protected branch and requires strict status checks.

## Fork trust boundary

The workflow analyzes the ordinary PR merge checkout on GitHub-hosted runners. Its only steps are checkout, CodeQL initialization, and
analysis; it does not install dependencies, build, run repository scripts, or
use repository secrets. Checkout does not persist credentials. Requested
permissions are `contents: read` and job-scoped `security-events: write`; this
public repository does not need `actions: read` for uploads.

[Fork PRs receive a read-only token and no repository secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories).
GitHub [permits CodeQL uploads from `pull_request` runs](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible)
without granting the fork a general write token. A maintainer may need to approve
the run under the repository's existing contributor policy. Approval starts the
workflow; it does not change that permission boundary. Preserve the existing
`first_time_contributors` approval policy.
Do not substitute `pull_request_target`, privileged `workflow_run` processing,
a personal access token, or a self-hosted runner.

## Verify results

For a current PR revision, verify both analysis jobs succeed, both SARIF uploads
finish processing, and both expected categories appear on the analyzed merge
revision. Match the run, analyzed SHA, and fresh analysis IDs; job success or
older results with matching categories do not establish processed results for
the current revision. Verify the processed `CodeQL` result and required-check
providers as well:

| Required check | GitHub App | App ID |
| --- | --- | --- |
| `test` | `github-actions` | 15368 |
| `Analyze (actions)` | `github-actions` | 15368 |
| `Analyze (javascript-typescript)` | `github-actions` | 15368 |
| `CodeQL` | `github-advanced-security` | 57789 |

For a main push, scheduled run, or manual run, verify both processed categories
on the run's main revision and analysis jobs from `github-actions`. These runs
do not need a `CodeQL` PR result check. Manual dispatch accepts a branch or tag,
not a commit SHA; when verifying main, dispatch with ref `main`, record its SHA
before dispatch, and confirm the run analyzed it. A main scan does not establish
pre-merge PR coverage.

Live fork approval and upload behavior has not been qualified. On a real
external contributor PR, verify the current head and merge SHAs, workflow event,
any contributor approval wait, both analysis jobs, processed categories/results,
and required checks. Verify a later head update produces fresh results. Report
only the approval behavior observed; a returning contributor does not establish
first-time contributor approval behavior. Workflow structure and same-repository
success alone do not prove fork coverage.

## Failures and recovery

If an upload fails, inspect the event, token permissions, default setup state,
and upload/processing error. If a required check remains pending or its provider
differs, investigate the run and current revision; do not rename, remove, spoof,
or relax the requirement. Preserve existing severity settings rather than
assuming thresholds from successful job or result checks.

If recovery requires switching scanning modes, obtain owner approval and capture
the current main SHA, scan configuration, workflow state, branch protections and
rulesets, alert severity settings, and contributor approval policy. Before
switching, also identify and record the intended owner-approved default-setup
fallback configuration, including its languages and query suite. Pause unrelated
merges and keep main stable during the switch.

To restore default setup, disable the Advanced workflow and finish or cancel its
active runs before applying the recorded default-setup fallback configuration.
Confirm a fresh main scan completes with both language analyses and processed
categories. On a fresh current-revision same-repository PR scan, verify the
`CodeQL` result and all required-check providers. Verify protections against the
captured settings before resuming merges. If restoration or either scan fails,
keep merges paused and escalate to the owner.

Leave the Advanced workflow disabled while default setup owns scanning; do not
rerun its uploads in that state. Restoring the previous default setup also
restores its fork exclusion. A later return to Advanced setup needs a reviewed,
owner-approved plan: disable default setup, wait for its analyses to finish,
enable the Advanced workflow if needed, then verify fresh processed Advanced
results on stable main and a current PR before resuming merges. If verification
fails, restore default setup before resuming merges. Preserve the trust boundary
above throughout recovery.

## Validation limits

Local tests and actionlint can check workflow structure, triggers, query and
category configuration, and the intended trust boundary. They cannot prove
GitHub fork approvals, token behavior, uploads, processed results, required-check
matching, or alert severity enforcement. Verify those through live results and
settings for the relevant event and revision.
