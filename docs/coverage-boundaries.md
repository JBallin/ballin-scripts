# Intentional coverage boundaries

**Audience:** Maintainers

This ledger records the production gaps reviewed for [#345](https://github.com/JBallin/ballin-scripts/issues/345).
Use the file, function and snippet anchors to find each boundary after source
lines move. Baseline line numbers identify the original c8 outcomes, not permanent
source locations. Keep this ledger current when behavior or tests change.

The baseline is commit `e778c429`, Node `v24.21.0`, V8
`13.6.233.17-node.53`, c8 `12.0.0`, on macOS arm64. `npm test` passed with
1,301 tests: 7,327/7,381 lines and statements, 2,551/2,634 branches, and
369/369 functions. The review starts with 54 uncovered lines and 83 branch
outcomes. Coverage scope and thresholds remain unchanged.

The feature gate before integration passed with 1,309 tests: 7,346/7,384 lines and statements
(99.48%), 2,568/2,642 branches (97.19%), and 369/369 functions (100%).
Tests cover 13 previously uncovered lines and eight baseline branch outcomes;
the sole invariant ignore covers three lines and one branch outcome. The
remaining 38 lines and 74 branch outcomes reconcile to the measured entries
below. Additional test execution exposes eight covered V8 branch ranges;
the dispatch annotation itself preserves its branch map and affects only the
default arm. No previously covered outcome became uncovered.

The integration gate including main `2059e2a` passed with 1,325 tests:
7,361/7,399 lines and statements (99.48%), 2,575/2,649 branches (97.20%),
and 370/370 functions (100%). After accounting for source-line shifts, the
same 38 lines and 74 branch outcomes remain measured; terminal styling adds
no uncovered outcomes. Thresholds and the sole annotation's scope are unchanged.

The follow-up gate on main `c93b4fd` passed with 1,427 tests:
7,635/7,673 lines and statements (99.50%), 2,759/2,836 branches (97.28%),
and 382/382 functions (100%). The exact maps retain 38 uncovered lines
and now report 77 branch outcomes. The original 74 measured outcomes remain;
backup preference anchors moved to `commands/backup_preferences.ts`. The three
additional outcomes are the exported `readPrompt` EOF operands and completion
setup's missing-target fallback, recorded below. `commands/setup.ts` has no
uncovered outcomes. These are current measurements; earlier totals describe their named
historical gates. Coverage scope, thresholds and the sole ignore are unchanged.

## Reading the dispositions

- **Tested:** add assertions about observable results and effects using existing
  isolated fixtures.
- **Ignored:** retain a fail-safe whose execution needs an invalid internal
  invariant; put a narrow directive and rationale beside the code.
- **Measured:** leave uncovered with the rationale below. The path still affects
  the coverage gate. A representative public failure test does not make every
  cause of a shared catch safe to ignore.

No production code was removed. Tests of normal I/O, persistence, identity,
cleanup, platform behavior and optional protection remain in coverage scope.
A measured location is a deliberate decision to retain signal, not a claim that
its execution is impossible or that a future behavioral test would be useless.

## Observable behavior covered by this review

| File and stable anchor | Baseline gap | Disposition and regression assertions |
| --- | --- | --- |
| `commands/backup_repository.ts`, `createRepositoryBackup`, `readRepositoryAccount(options).id !== account.id` and created response owner/private/name checks | Branches 568, 571; lines 572–573 | **Tested.** A changed effective account prevents creation. A mismatched created owner, visibility or name prevents marker publication and further reads; creation is not retried. See the creation identity cases in `test/backup_repository.test.ts`. |
| `commands/install_setup.ts`, `updateConfig`, `updateResult.stderr` / unsuccessful child status | Branches 129, 133; lines 130–131, 134–135 | **Tested.** A failing fixture migration passes stderr through, returns failure, preserves config bytes and emits no success output. See `propagates an installed config migration failure` in `test/install_setup.test.ts`. |
| `commands/install_setup.ts`, `configureBackup`, legacy-Gist arm with `repositoryName !== undefined` | Branches 350, 354; lines 355–357 | **Tested.** An explicit repository name cannot replace a configured Gist. Config bytes remain intact and no GitHub command runs. See `rejects repository setup while a Gist is configured` in `test/install_setup.test.ts`. The test also exercises reading the original config when none is supplied. |
| `commands/backup.ts`, `runBackupCommand`, `!configure(repoDir, backupSetupDocsUrl, configPath, true)` | Branch 926; lines 927–930 | **Tested.** Failed migration stops setup before any remote request or cache creation and retains config bytes. See `stops backup setup when installed config migration fails` in `test/repository_backup.test.ts`. |
| `commands/repo_update.ts`, `runRepoUpdateCli`, `updateInstalledRepo(repoDir) ? 0 : 1` | Branch 119 | **Tested.** Failed stubbed fetch returns status 1 and stops before checkout/merge. See `returns failure and stops before checkout` in `test/repo_update.test.ts`. |

## Retained fail-safe

| File and stable anchor | Baseline gap | Disposition and rationale |
| --- | --- | --- |
| `commands/ballin.ts`, `runBallinCommand`, exhaustive switch `default` / `const unhandledCommand: never` | Branch 197; lines 198–200 | **Ignored.** `isTopLevelCommandName` rejects external unknown commands before the exhaustive switch. The default protects future dispatcher edits; executing it requires a mismatch between that internal name union and the cases. The public dispatcher tests exercise recognized routes and rejection of unknown names. The directive covers only this default arm. |

## Boundaries left measurable

The following entries preserve the uncovered signal. Test filenames identify the
owning isolated regression suites; they do not claim those suites cover each
listed outcome. Cleanup and persistence assertions elsewhere in a suite do not
justify hiding additional failure causes in these paths.

| File / function / snippet anchor | Baseline branch starts (and uncovered lines when present) | Rationale and owning tests |
| --- | --- | --- |
| `analytics-worker/report.ts`, `wranglerArgsFor` and `runWrangler`, `options.rootDir ??`; `table`, `row[column]?.length ?? 0` | 217, 240, 293 | Runtime-root defaults and sparse-row formatting retain signal. Tests inject temporary roots to avoid real Wrangler configuration; the rectangular report rows do not need artificial sparse cells solely to execute the width fallback. `test/analytics_report.test.ts`. |
| `analytics-worker/report.ts` and `reset.ts`, `runCli`, `error instanceof Error`; `verify-deployment.ts`, `runCli`, same check | report 424; reset 249; verification 142 | Arbitrary thrown-value formatting remains measured. Existing failure contracts use errors from real parser/runner boundaries; injecting unusual thrown primitives only for an operand adds little protection. `test/analytics_report.test.ts`, `test/analytics_reset.test.ts`, `test/analytics_deploy.test.ts`. |
| `analytics-worker/reset.ts`, `wranglerArgsFor` and `runWrangler`, `options.rootDir ??` | 96, 159 | Keep installed-root resolution measurable; isolated tests supply temporary roots rather than reading or changing real deployment configuration. `test/analytics_reset.test.ts`. |
| `commands/analytics.ts`, `replaceInvalidLocalInstallId`, `writeLocalInstallId`, `writeAnalyticsPreference`, `runWithCommandAnalytics`, `finally` | 234, 267, 289, 589 | V8 reports additional finally ranges despite existing lifecycle, cleanup and runtime-restoration assertions. No blanket finally ignore: ownership cleanup and analytics isolation remain meaningful behavior. `test/analytics.test.ts`. |
| `commands/backup.ts`, `compareBackupFileNames`, `leftKey === rightKey` | 108; lines 109–110 | Current fixed snapshot names have distinct normalized sort keys. Retain equality for a valid comparator and keep its signal; do not manufacture duplicate production definitions or expose the private comparator solely to test it. `test/backup.test.ts`. |
| `commands/backup.ts`, `backupConfig`, `readGistMetadata`, `errorMessage`, `error instanceof Error` | 150, 305, 413 | Non-Error diagnostic variants remain measured. Public malformed-config/metadata and transport failures already assert diagnostics; no need to throw primitive values solely for formatting operands. `test/backup.test.ts`. |
| `commands/backup.ts`, `readGistMetadata`, cleanup `finally` | 308 | Keep private transport cleanup measured; no suppression of the finally range or filesystem errors. Metadata/cleanup fixtures in `test/backup.test.ts`. |
| `commands/backup.ts`, `captureSnapshotInput`, `snapshot.args ?? []` | 343 | Supported snapshot definitions supply arguments. Keep the default as signal for future collectors, without rewriting definitions just to execute it. Collector fixtures in `test/backup.test.ts`. |
| `commands/backup.ts`, `readRemoteSnapshots`, per-file and outer `catch` | 570, 576; lines 571–573, 577–578 | Shared catches can include ordinary read/stat/storage failures as well as disappearance races. Leave them measurable; existing failed/incomplete remote-read assertions are not proof that every filesystem cause is redundant. `test/backup.test.ts`. |
| `commands/backup.ts`, `evaluateSnapshots`, `!remote`; `runStagedBackup`, reconciliation `catch` | 599, 767; lines 600–601, 768–770 | The completed remote map normally contains every staged name. Retain the invariant guard without an ignore because the enclosing reconciliation catch can also handle real file comparison errors. Testing a missing entry alone would require mutating a private completed map. `test/backup.test.ts`. |
| `commands/backup.ts`, `updateGist`, preparation `catch` | 694; lines 695–696 | Serialization and temporary payload writes can fail independently of successful temporary creation. Keep the shared catch measurable rather than classifying all preparation failures as concurrent mutation. Publication/non-mutation fixtures in `test/backup.test.ts`. |
| `commands/backup.ts`, `runRepositoryBackup`, `if (unexpected)` and `repositoryMessages[problem] ??` | 813, 843 | The retained-entry warning and unexpected-error fallback are public diagnostics. Keep signal rather than suppressing them; transport tests already verify retaining unsupported entries, but do not substitute for command-level warning assertions. `test/repository_backup.test.ts`, `test/backup_repository.test.ts`. |
| `commands/backup.ts`, `runRealBackup`, repository `catch` | 875; lines 876–878 | Unexpected exceptions outside the repository pipeline still fail the command. Keep this outer safety boundary measurable, independently of handled pipeline failures. `test/repository_backup.test.ts`. |
| `commands/backup.ts`, `runBackupCommand`, analytics `catch` | 977; lines 978–979 | The analytics call must not replace the backup outcome. Its normal API already isolates delivery failures; a synchronous throw at this boundary needs a substituted module. Retain this fail-safe and its signal. Analytics assertions in `test/repository_backup.test.ts`. |
| `commands/backup.ts`, `runBackupCommand`, browse `result.error` and read/open diagnostic fallback | 1000, 1003 | Spawn and unexpected read/open failures remain measurable. Existing read/open fixtures assert ordinary status failures; do not hide the distinct missing-command or unclassified exception paths. `test/repository_backup.test.ts`. |
| `commands/backup_repository.ts`, `protectionTransportFailure`, `!(error instanceof RepositoryError)`; `inspect`, `inspectRepository`, error classification; `createRepositoryBackup`, error normalization | 70, 286, 291, 585 | Unknown exceptions remain measurable as local-I/O/uncertain outcomes. Current transport helpers classify their own failures; unfamiliar exceptions must still fail closed, so no broad catch exclusion. `test/backup_repository.test.ts`. |
| `commands/backup_repository.ts`, `ensureManagedBranchRuleset`, `mutationFailure` / `detailResult` after reconciliation | 501, 503, 504, 505 | These combine creation/detail and confirmation failures; retain signal for local-I/O, permission, mismatch and unexpected outcomes. Existing single-failure/reconciliation cases protect no-repeat behavior, but cannot justify excluding these combinations. `test/backup_repository.test.ts`. |
| `commands/backup_repository.ts`, `publish`, `confirmation.status !== 'complete'` | 540 | Incomplete readback must prevent publication success. Existing ambiguous/missing-commit and malformed readback cases remain relevant; preserve this separate confirmation boundary for future fixture coverage. `test/backup_repository.test.ts`. |
| `commands/backup_preferences.ts`, `saveBackupConfig`, `finally`; `reviewAutomaticUpdateBackup`, `catch` | 33, 48 | Staging cleanup and later preference persistence failures remain measured. The saved destination must remain authoritative even if subsequent preference access fails. Existing failed-save assertions cover the public recovery contract, without suppressing other read/write causes. `test/repository_backup.test.ts` and `test/setup_preferences.test.ts`. |
| `commands/backup_preferences.ts`, `reviewSensitiveSources`, `!logical` / non-file source / `!isFile()` | 82, 84 | Current sensitive definitions, except separately handled pipx, discover file sources. Keep schema guards and post-discovery filesystem checks measurable: a source can change type during review, and future definitions must still fail closed. Sensitive-review fixtures in `test/repository_backup.test.ts` and `test/setup_preferences.test.ts`. |
| `commands/backup_setup.ts`, exported `readPrompt`, `line.eof && !line.text ? eofResponse : line.text` | Current `c93b4fd`: two outcomes at 17 | The legacy Gist host prompt in `commands/install_setup.ts`, `configureGist`, still calls this helper. EOF handling can affect the selected host and remains measured; newline-response fixtures do not establish empty-EOF or partial-line EOF behavior. Keep these reachable outcomes visible for future caller-level regression assertions. Owning suite: `test/install_setup.test.ts`. |
| `commands/backup_setup.ts`, `configureRepositoryBackup`, renamed destination `!saveBackupConfig`; message fallback | 153, 223 | Renamed-destination persistence is ordinary I/O; keep its failure measurable. Unknown diagnostic codes likewise remain visible. Revalidation/failed-linkage fixtures in `test/repository_backup.test.ts`. |
| `commands/backup_setup.ts`, `disconnectBackup`, backup/update shape fallbacks | 237, 238 | Validated configuration normally supplies object sections. Keep fallback signal without constructing an internal config shape that prior validation rejects. Disconnect fixtures in `test/repository_backup.test.ts`. |
| `commands/backup_snapshots.ts`, `errorCode`, `inspectPath`, `inspectTool`, `error instanceof Error` | 155, 172, 197 | Filesystem/process errors normally use Error objects. Keep unexpected thrown-value handling measured rather than injecting primitives only for coverage. `test/snapshot_definitions.test.ts`. |
| `commands/backup_snapshots.ts`, `inspectTool`, `env.PATH ?? ''` | 178 | Keep absent-PATH discovery behavior measurable. Tool-discovery fixtures supply isolated PATH entries and avoid host tools. `test/snapshot_definitions.test.ts`. |
| `commands/ballin.ts`, `runDoctorCommand`, config-path environment fallback | 149 | Public fixtures supply isolated config paths. Keep installed-config resolution measurable instead of reading real user configuration to execute the fallback. Doctor cases in `test/ballin.test.ts`. |
| `commands/completion_setup.ts`, `offerCompletionSetup`, `if (!target)` | Current `c93b4fd`: 122 | A skipped, unsupported or unconfirmed startup target must show the manual-completion guidance without writing a profile. Target-level tests exercise those decisions, but do not cover this caller's fallback. Keep this reachable behavior measured for a future caller-level regression assertion. `test/completion_setup.test.ts`. |
| `commands/doctor_report.ts`, `formatDoctorCheck`, `nextSteps[check.id] ??` | 38 | Current readiness check IDs have next-step entries. Retain the fallback for future IDs and its signal without inventing an unsupported check solely for formatting coverage. Doctor report cases in `test/ballin.test.ts`. |
| `commands/install_setup.ts`, `readOriginalSetupConfig`, unknown-error message fallback | 68 | Filesystem/JSON failures supply Error objects. Keep unknown diagnostic handling measured; config-read failure fixtures already assert recovery behavior. `test/install_setup.test.ts`. |
| `commands/install_setup.ts`, `setConfigValue`, unsuccessful write; `replaceInvalidBackupHost`, shape guard / write `catch` | 172, 185, 194; lines 173–174, 186–187, 195–196 | Ordinary persistence failures and config mutation remain measurable. Do not suppress shared write catches merely because immediate shape changes are uncommon. Config preservation/host-repair fixtures in `test/install_setup.test.ts`. |
| `commands/install_setup.ts`, `configureGist`, host save/readback failures and marker stderr | 261, 265, 284, 288, 326, 338; lines 262–263, 266–267, 285–286, 289–291, 327–328, 339–340 | Retain signal for failed host persistence, invalid readback and stderr passthrough. Existing adoption/repair fixtures cover preservation but do not make every storage or concurrent mutation failure an invariant. `test/install_setup.test.ts`. |
| `commands/install_setup.ts`, `configureBackup`, missing original config | 351 | Keep invalid/missing setup-context failure measurable; the new legacy-Gist test exercises the successful default context reader, not this failure. `test/install_setup.test.ts`. |
| `commands/install_setup.ts`, `validateBinDirInPath`, absent PATH; `runInstallSetupCli`, failed `setupAnalytics` | 406, 511 | Preserve default environment and direct CLI failure signal. Fixtures use isolated PATH and existing analytics staging cases; no real environment activation is needed. `test/install_setup.test.ts`. |
| `commands/self_update.ts`, `runSelfUpdateCommand`, absent HOME; `commands/uninstall.ts`, `runUninstallCommand`, absent HOME/system-root override | self-update 15; uninstall 65, 67 | Keep installed-root/platform defaults measurable. Fixtures explicitly select temporary roots so maintenance and removal cannot touch user state. `test/self_update.test.ts`, `test/uninstall.test.ts`. |
| `commands/update.ts`, `readConfigObject`, `runUpdateCommand`, non-Error diagnostic operands | 71, 247 | Keep unfamiliar thrown-value handling measurable; real config failures are already tested without artificial primitive throws. `test/update.test.ts`. |
| `commands/update.ts`, `runNvmInstall`, successful status with missing captured env; `nodeVersionForEnv`, empty stdout | 173, 205 | Environment capture loss and empty version output are meaningful runtime failures. Preserve their signal; existing NVM/process fixtures cover adjacent failures, without suppressing these combinations. `test/update.test.ts`. |
| `commands/update.ts`, `ballinCommandPath`, installed shim default; `reportBallinReadiness`, config-path fallback | 209, 216 | Child fixtures select a stubbed shim and temporary config. Keep production defaults measurable rather than invoking real maintenance or user configuration. `test/update.test.ts`. |

## Updating the ledger

After changing behavior or adding tests, regenerate the exact c8 maps from the
complete `npm test` run and reconcile remaining outcomes against these anchors.
For any new ignore, compare before/after outcomes after accounting for shifted
source lines. Reject an annotation that also suppresses neighboring meaningful
behavior. Do not raise thresholds mechanically or narrow included production
files to make this ledger empty.
