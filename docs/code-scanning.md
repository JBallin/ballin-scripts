# Code scanning

*Maintainer guide to staging, activating, verifying, and rolling back CodeQL.*

## Staged setup

Ballin still uses CodeQL default setup. The checked-in
[workflow](../.github/workflows/codeql.yml) is manual-only staging for Advanced
setup; merging it does not add fork PR scans or complete
[#466](https://github.com/JBallin/ballin-scripts/issues/466).
Do not dispatch it while default setup is enabled:
[GitHub rejects Advanced CodeQL uploads in that state](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/troubleshoot-sarif-uploads/default-setup-enabled).
Default setup continues supplying existing same-repository PR scans.

The candidate retains the observed default scan configuration: Actions and
JavaScript/TypeScript, `build-mode: none`, the default query suite, no custom
queries, model packs, or additional threat models, and categories
`/language:actions` and `/language:javascript-typescript`. It pins the verified
checkout v6 and CodeQL v4 revisions. Review action updates deliberately; adding
languages or queries is a separate coverage change.

The intended automatic triggers are ordinary `pull_request` to `main`, push to
`main`, and a weekly schedule. `main` is currently the only protected branch.
The activation step below adds those triggers only after main uploads succeed.
No path filters or fork exclusion should suppress a required scan.

## Fork trust boundary

Once activated, the workflow analyzes the ordinary PR merge checkout on
GitHub-hosted runners. Its only steps are checkout, CodeQL initialization, and
analysis; it does not install dependencies, build, run repository scripts, or
use repository secrets. Checkout does not persist credentials. Requested
permissions are `contents: read` and job-scoped `security-events: write`; this
public repository does not need `actions: read` for uploads.

[Fork PRs receive a read-only token and no repository secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories).
GitHub [permits CodeQL uploads from `pull_request` runs](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible)
without granting the fork a general write token. A maintainer may need to approve the run under
the repository's existing contributor policy. Approval starts the workflow; it
does not change that permission boundary. Preserve the existing approval policy.
Do not substitute `pull_request_target`, privileged `workflow_run` processing,
a personal access token, or a self-hosted runner.

## Approved transition

Repository settings changes and automatic activation require explicit owner
approval. The staging PR authorizes neither. Keep all existing required checks
and protection settings throughout; do not use an administrator bypass to land
the activation PR.

1. Merge the reviewed manual-only staging PR through the normal required checks.
   Prepare an activation branch and review its trigger change before switching
   settings. Run `npm test` and actionlint on that candidate.
2. Immediately before cutover, capture the current main SHA, default setup
   configuration and successful scans, workflow enabled state, full branch
   protection/rulesets, code-scanning alert gate/severity settings, and fork
   workflow approval policy. An owner must supply settings unavailable through
   the inspecting account. Preserve unknown settings rather than assuming
   defaults. Reconcile any drift from the baseline below before proceeding.
3. Pause unrelated merges and keep main stable. With separate approval, switch
   off default setup. Re-enable the staged workflow if GitHub disabled it during
   the setup switch, then dispatch it on the captured main revision. This is a
   bounded transition interval: the previous scan covers stable main while the
   replacement runs. Advanced uploads cannot be qualified concurrently with
   default setup. If the run or result processing fails, roll back before
   resuming merges.
4. Require both analysis jobs to succeed, both SARIF uploads to finish processing,
   and both expected categories to appear on that main revision. Verify the
   analysis jobs come from `github-actions`. Main scans do not need a `CodeQL`
   PR result check: verify that result gate and its provider in step 6. Job
   success alone does not prove processed results. A manual main run also does
   not qualify fork PR uploads.
5. Open the reviewed activation PR, replacing the workflow's `on` block with the
   following and removing the staging comment. Update the manual-only trigger
   assertion in `test/codeql_workflow.test.ts` to validate these automatic
   triggers, and update this guide to describe the activated setup. Leave the
   scan jobs, query configuration, categories, and required checks unchanged.

   ```yaml
   on:
     pull_request:
       branches: [main]
     push:
       branches: [main]
     schedule:
       - cron: '23 4 * * 2'
     workflow_dispatch:
   ```

6. Use that same-repository PR to verify `test`, both analysis jobs, and the
   processed `CodeQL` result on its current head/merge revision. If a required
   check remains pending or its provider differs, stop and investigate; do not
   rename, remove, spoof, or relax the requirement. The human owner merges only
   after this evidence is complete. Verify the resulting main push scan.
7. Open a harmless contributor-fork PR against activated main, using a small
   documentation edit. Record its current head SHA and merge SHA, workflow
   event/run, any approval wait and approval, both language jobs, processed
   categories/results, and required checks. Verify a new harmless head update
   produces fresh evidence, rather than relying on the earlier revision. Resume
   unrelated merges only after qualification succeeds. Keep #466 open until
   actual current-head same-repository and fork results establish coverage.

The weekly time above is UTC. Scheduled scans run on the default branch; verify
the first scheduled run after activation separately from PR qualification.
Retarget or update other open PRs as needed to obtain results for their current
revision after cutover. Earlier default results or a post-merge main scan do not
establish pre-merge fork coverage.

Baseline observed on 2026-10-06 (recheck at cutover):

| Required check | GitHub App | App ID |
| --- | --- | --- |
| `test` | `github-actions` | 15368 |
| `Analyze (actions)` | `github-actions` | 15368 |
| `Analyze (javascript-typescript)` | `github-actions` | 15368 |
| `CodeQL` | `github-advanced-security` | 57789 |

The baseline has strict required status checks, no repository rulesets, and
`first_time_contributors` fork workflow approval. Full branch protection was read
successfully; code-scanning alert thresholds still need owner confirmation at
cutover. No identity or protection change is planned.

## Rollback

Keep unrelated merges paused. With the approved rollback authority, disable the
Advanced workflow before restoring the captured default setup configuration.
Confirm default setup is configured for the captured languages/query suite and
that a fresh main scan finishes with both language analyses and processed
categories. Verify the expected `CodeQL` PR result and all required-check
providers on a fresh current-revision same-repository PR scan. Verify protections
against the captured settings before resuming merges. If restoration or either
scan fails, leave merges paused and escalate to the owner.

Leave the Advanced workflow disabled while default setup owns scanning; do not
rerun its uploads in that state. A later retry needs a reviewed activation plan.
Rollback restores the existing fork exclusion, so #466 remains unresolved.

## Validation limits

Local tests and actionlint qualify workflow structure, staging triggers, query
and category continuity, and the intended trust boundary. They cannot prove
GitHub fork approvals, token behavior, uploads, processed results, required-check
matching, or alert severity enforcement. Those require the approved transition
and live same-repository/fork qualification above.
