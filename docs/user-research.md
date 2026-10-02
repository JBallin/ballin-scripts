# User interviews and trials

**Audience:** Maintainers conducting research for
[#276](https://github.com/JBallin/ballin-scripts/issues/276).

This guide prepares research; it does not establish demand or trial readiness.
Use the [evidence template](user-research-evidence.md) to distinguish observed
behavior, reported history, and interpretation. Keep raw notes privately.

## Prepare a small initial round

Plan 8–12 behavior-based interviews before writing a survey. Include macOS
developers without maintained dotfiles, people who abandoned configuration tools,
recent Mac migrators, and people with one mature primary Mac. Groups may overlap.
Include several people outside the maintainer's immediate network; record broad
workflow groups privately and report only groups large enough to avoid identifying
people. AI-heavy developers are a secondary segment.

Test whether a working Mac serves as the source of truth, whether low-curation
capture preserves otherwise forgotten state, and whether maintenance creates
repeat value. Ask what Ballin would replace and what prevents adoption. Do not
assume interest, successful installation, or a useful snapshot implies retention.

The July 2026 feedback in #276 came from one technically experienced prospective
user who did not install. It motivates testing maintenance-only adoption, installer
trust, and personal or AI-generated scripts as substitutes. It does not establish
representative demand or justify splitting packages.

## Interview: about 30 minutes

Before introducing Ballin, explain that the purpose is to understand their existing
workflow. Participation and screen sharing are optional; they can skip questions,
stop, or describe actions without showing files. Do not request credentials,
snapshot contents, repository identities, or other sensitive setup details.
Agree on note-taking and any recording separately; do not record by default.

1. **Last real event:** “Tell me about the last time you replaced, migrated, or
   recovered a Mac. What triggered it? Walk me through what you actually did.”
   If none, ask about the last time they recovered a missing tool or setting.
2. **Source of truth:** “What did you consult? Which notes, scripts, backups,
   services, or parts of the old Mac did you rely on? What was missing?” Ask for
   a safe reconstruction rather than requiring file contents.
3. **Cost and workarounds:** “What did you forget or rediscover? How did you
   notice? What time or work did that cost? What did you change afterward?”
4. **Alternatives:** “What setup tools have you tried? What happened the last
   time you used or stopped using them?” Include partial scripts, generated
   shell functions, Time Machine, notes, and doing nothing in follow-up probes.
5. **Maintenance:** “Walk me through your most recent routine update. Which
   commands did you run, what did you check, and what did you postpone?”
6. **Boundaries:** “What configuration would you refuse to upload, and why?
   What would you need to inspect before installing a tool that reads it?”

Only then show a short description grounded in the current
[capabilities](capabilities.md) and [installation guide](installation.md).
Ask: “Where, if anywhere, would this fit in the workflow you described? What
would you stop doing? Which saved output would help with that particular task?”
Ask for concrete tradeoffs and reasons it would not fit. Avoid “Would you use
this?” and feature wish lists. Discuss verification or rebuild planning only as
possible unmet outcomes; do not present them as existing functionality.

## Moderated trial: after the private-backup milestone

Before each trial, check bounded onboarding readiness from
[#273](https://github.com/JBallin/ballin-scripts/issues/273) and completion of the
private-backup cutover in
[#334](https://github.com/JBallin/ballin-scripts/issues/334). Record the actual
release/commit and reviewed documentation privately. Use the architecture and
commands available in that version; do not design a new trial around legacy Gists.
If this gate is unmet, conduct the behavior interview and defer installation.

Invite real personal-Mac use only if the participant is comfortable with the
documented effects. The participant drives installation and chooses whether to
configure backup. Declining or stopping is useful evidence. Do not override a
privacy choice to obtain a completed trial. Maintainer automated walkthroughs
remain isolated as required by repository instructions.

1. Ask them to use the published installation instructions and think aloud.
   Observe what they inspect before proceeding. Record missing prerequisites,
   confusion, elapsed time, and every intervention; allow pauses for decisions.
2. Let them choose maintenance-only setup or optional private-repository backup.
   Observe GitHub authentication, destination selection, and the single sensitive-
   source choice. Record refusals and concerns without recording their values.
3. Before backup, ask them to explain what will be captured, who can access it,
   and what it will help recover. Check their understanding against the current
   installation and [source policy](backup-sources.md). GitHub and authorized
   accounts can access private-repository data; a snapshot is a rebuild reference,
   not automatic restoration of dotfiles or an entire machine. Clarify harmful
   misunderstandings before proceeding and record the intervention.
4. If they proceed, observe first backup and available inspection surfaces such
   as `ballin backup open` or `ballin backup read <file>`. Let them choose an
   artifact to inspect privately. Record whether it helped a concrete task or
   revealed forgotten state, without copying the content. A successful upload
   alone is not time to first useful snapshot.
5. Ask what existing action this replaces, what they will continue doing, and
   what would cause them to remove Ballin. For maintenance-only users, record
   the intended recurring job; do not run updates solely to complete the study.

Agree on a follow-up window suited to their normal maintenance cadence, such as
2–4 weeks. Do not send use reminders during that window. At its end, ask about
actual backup/update use, inspection, replacement behavior, and reasons for
non-use. Record whether use preceded contact and whether it was prompted.
No follow-up response is unknown, not demonstrated non-use. Never contact
participants without authorization.

## Decide from evidence

Use the template to review completion with help, useful discoveries, artifact
inspection, workflow replacement, accurate security/recovery understanding,
and unprompted repeat use. Report denominators and contradictory observations.
Set any working thresholds before the round; these are research heuristics,
not universal benchmarks. Small convenience samples cannot establish market size.

Choose continue, narrow, reposition, or low-maintenance explicitly, with evidence
and limitations. Do not turn divergent requests into a larger roadmap. Write a
survey only after interview language is clear; scope any secondary community
research to questions that actual interviews leave unresolved. Do not repeat the
completed competitor assessment.
