# Batch 3 gallery fidelity check

Candidate: `5fe81405e0a729eb4af361509015fe932ddc3c75`. The gallery does not change product source. Final source includes the narrow Node.js wording correction described below. This is source/call-order inspection and disposable display verification only.

## Necessary corrections

- Replaced the incomplete main installation excerpt with a coherent Quickstart sequence containing all 13 applicable fixed-choice prompts. Added the initial backup and Node decisions, entered the general review, showed all eligible questions and Analytics, and used its actual general-first consolidated reminders before the PATH-success footer.
- Removed the impossible existing-backup-review “cancel after saved answer” alternative; retained the distinct truthful paths whose earlier choices were saved.
- Named omitted prompts/stages in every selected alternative. Removed the inaccurate generic “dependency work” description; exact checkout/publication/link stages are named in order.
- Create and Reconnect remain independent complete-prompt standalone examples; their `Run ballin setup` lines are next actions, not executed review flows.

| Section | Result/conditions | Pinned source |
|---|---|---|
| 1 | Decision excerpts only; preceding backup choice and later installation/shell/completion/preferences explicitly omitted. | `quickstart.sh:990` |
| 2 | Coherent fresh Quickstart: all 13 applicable fixed-choice prompts in source order. Backups declined; compatible Node opted into fresh NVM; successful shell/PATH; completion Yes; general review Yes, all eligible preferences and Analytics No. Noninteractive omissions named. | `quickstart.sh:1441; quickstart.sh:1477; commands/install_setup.ts:222; commands/setup.ts:66` |
| 3 | Complete standalone preference questions for NVM unavailable/saved off and backup unconfigured/saved off; NVM alternatives explicitly question/note-only. | `commands/setup.ts:69; commands/setup.ts:74` |
| 4 | Standalone Create with local config present and valid auth. Consent, hostname, Create, repository name, sensitive-source choice and final Create confirmation all shown. Transient initialization omitted by name; general setup appears only as related next action. | `commands/backup_setup.ts:114; commands/backup_setup.ts:196; commands/backup_setup.ts:309` |
| 5 | Standalone Reconnect with existing remote lacking portable-preference snapshot. All six applicable input/consent steps shown. Protection alternatives are message-only with omitted stages named; no general-review journey stitched onto success. | `commands/backup_setup.ts:263; commands/backup_setup.ts:64` |
| 6 | Outcome excerpts only. Embedded backup No has no immediate deferred next-action line; installer reminders consolidate once. General-first versus backup-first and standalone related-only conditions retained; earlier prompts named as omitted. | `commands/backup_setup.ts:76; commands/install_setup.ts:265` |
| 7 | Outcome excerpts identify omitted trigger and preceding prompts. Removed impossible existing-backup-review cancellation after saved answer: pinned review asks only sensitive-source choice and then saves/completes; its EOF cancellation occurs before that save. Retained truthful final-Create No after earlier sensitive choice saved, and general-review EOF after earlier preference saved. | `commands/backup_setup.ts:169; commands/backup_setup.ts:300; commands/setup.ts:57` |
| 8 | Independent prompt/outcome excerpts. Analytics, Create/Reconnect, Bash Skip, PATH-unverified ending and completion No/EOF explicitly identify surrounding omitted questions/stages. Not a contiguous journey. | `quickstart.sh:1309; commands/completion_setup.ts:179` |
| 9 | Source-owned error blocks have no hidden choice prompts. Proposal/summary examples explicitly omit checkout/refresh/backup-validation output and assume unchanged backup scope. Cancellation excerpt names omitted identity/release-notes prefix. Synthetic provenance is not runtime verification. | `commands/repo_update.ts:135; commands/self_update.ts:137` |
| 10 | Pure doctor/help rendering, synthetic doctor data; no interactive prompts or real checks claimed. | `commands/doctor_report.ts:63; commands/setup.ts:12` |

## Verification

All four display captures exited 0: redirected/plain, normal native PTY, NO_COLOR PTY and dumb PTY. Assertions cover the exact 13-question main order, one main success footer, reminder order, explicit excerpt labels, raw quoted config paths, missing-key backticks and existing color/fallback checks. Source/formatter hashes and anchors are recorded in `provenance.json` and `source-anchors.json`; captures in `verification.json`. No live flow, input redraw, VM, network, installation, update or backup was executed. Batch 2 is unchanged.


Final-head provenance: candidate `5fe81405e0a729eb4af361509015fe932ddc3c75`; product/VM-tested head `8d3b1ab785d98e9a7c3e37f662dda891120da71d`. Intermediate `4e99f263b5ebfe460715d4f4709ada478e7e34ef` contains only CI archive-upload/docs/workflow-test changes. The final delta contains literal Node → Node.js guidance substitutions in four product/generated/shared source files and two focused tests; exact substitutions were checked against Git objects. Parent reports 75 focused tests and lint/type/release/ShellCheck validation. It was not rerun in the VM. Do not treat final product-source bytes as identical to the VM-tested head. All 13 main-flow prompts and fidelity corrections remain intact. The affected runtime-guidance failure snippets are not shown as gallery scenarios; their exact final wording is preserved in source anchors/snapshots.
