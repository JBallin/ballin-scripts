# Code scanning

*Maintainer guide to staging, activating, verifying, and rolling back CodeQL.*

## Advanced setup

The checked-in [workflow](../.github/workflows/codeql.yml) enables Advanced
CodeQL scans for ordinary pull requests to `main`, pushes to `main`, a weekly
schedule, and manual dispatch. Publish this activation change only through the
approved transition below, after default setup is disabled and the manual-only
workflow has produced processed results on stable main. Publishing the PR can
start its automatic scan before merge. Do not dispatch Advanced scans or open
an activation PR while default setup is enabled:
[GitHub rejects Advanced CodeQL uploads in that state](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/troubleshoot-sarif-uploads/default-setup-enabled).
The manual-only staging workflow landed in
[#509](https://github.com/JBallin/ballin-scripts/pull/509). Keep
[#466](https://github.com/JBallin/ballin-scripts/issues/466) open until current-head
same-repository and fork scans pass the qualification below; adding automatic
triggers alone does not establish that coverage.

The candidate retains the observed default scan configuration: Actions and
JavaScript/TypeScript, `build-mode: none`, the default query suite, no custom
queries, model packs, or additional threat models, and categories
`/language:actions` and `/language:javascript-typescript`. It pins the verified
checkout v6 and CodeQL v4 revisions. Review action updates deliberately; adding
languages or queries is a separate coverage change.

`main` is currently the only protected branch. The workflow has no path filters
or fork exclusion to suppress a required scan.

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

1. The manual-only staging PR, #509, is merged. Prepare and review the activation
   trigger change locally before switching settings. Run `npm test` and
   actionlint on that candidate. Keep the candidate unpublished until the
   manual main qualification in step 4 succeeds.
2. Immediately before cutover, capture the current main SHA, default setup
   configuration and successful scans, workflow enabled state, full branch
   protection/rulesets, code-scanning alert gate/severity settings, and fork
   workflow approval policy. Capture alert thresholds where available and
   preserve any uncaptured settings without assuming defaults. Main upload
   qualification does not require choosing a new severity policy. Verify the
   existing PR result gate and provider in step 6. Reconcile observed drift
   from the baseline below before proceeding.
3. Pause unrelated merges and keep main stable. With separate approval, switch
   off default setup. Wait for its state to become `not-configured` and any
   already-running default analyses to finish. Re-enable the staged workflow if
   GitHub disabled it during the setup switch, then dispatch it with ref `main`.
   Confirm main still matches the captured SHA before dispatch and confirm the
   resulting run analyzed that SHA. [Dispatch accepts a branch or tag](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
   rather than a commit SHA. This is a bounded transition interval: the previous
   scan covers stable main while the replacement runs. Advanced uploads cannot be
   qualified concurrently with
   default setup. If the run or result processing fails, roll back before
   resuming merges.
4. Require both analysis jobs to succeed, both SARIF uploads to finish processing,
   and both expected categories to appear on that main revision. Verify the
   analysis jobs come from `github-actions`. Record fresh Advanced analysis IDs
   linked to the approved run, upload, and captured SHA; preexisting default
   analyses with matching categories do not qualify. Main scans do not need a `CodeQL`
   PR result check: verify that result gate and its provider in step 6. Job
   success alone does not prove processed results. A manual main run also does
   not qualify fork PR uploads.
5. After step 4 succeeds, publish the reviewed activation PR with the following
   trigger block, its updated trigger assertion, and this guide. If main changed,
   stop and reconcile the candidate and qualification before publishing. Leave
   the scan jobs, query configuration, categories, and required checks unchanged.

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
   after this evidence is complete. Verify the resulting main push scan, then
   resume unrelated merges after main and same-repository qualification succeed.
   Keep #466 open with contributor-fork coverage explicitly unverified.
7. Defer fork qualification until the next real external contributor PR against
   activated main. No new account or synthetic contributor PR is needed for the
   main cutover. On that real PR, record its current head SHA and merge SHA,
   workflow event/run, observed contributor approval classification and any
   wait/approval, both language jobs, processed categories/results, and required
   checks. Verify a later real head update produces fresh evidence rather than
   relying on the earlier revision. Keep #466 open until actual current-head
   same-repository and fork results establish coverage. Report only the approval
   behavior actually observed; do not infer first-time approval from a returning
   contributor.

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
successfully; exact alert thresholds were not captured. Preserve the existing
severity settings and verify the actual PR result gate during activation.
No severity policy, identity, or protection change is planned.

## Rollback

Keep unrelated merges paused. With the approved rollback authority, disable the
Advanced workflow and wait for its active runs to finish, or cancel them, before
restoring the captured default setup configuration.
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

Local tests and actionlint qualify workflow structure, automatic triggers, query
and category continuity, and the intended trust boundary. They cannot prove
GitHub fork approvals, token behavior, uploads, processed results, required-check
matching, or alert severity enforcement. Those require the approved transition
and live same-repository/fork qualification above.
