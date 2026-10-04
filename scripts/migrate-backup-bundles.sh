#!/usr/bin/env bash
# Run manually. This helper leaves its new clone for review and never pushes or deletes it.
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail 'Usage: bash migrate-backup-bundles.sh <repository-url> <new-local-folder>'
[[ -z ${GIT_DIR-}${GIT_WORK_TREE-}${GIT_INDEX_FILE-}${GIT_COMMON_DIR-} ]] \
  || fail 'Unset Git directory/worktree/index overrides before running this helper.'
repository=$1
destination=$2
# Only ordinary GitHub HTTPS/SSH URLs or absolute local paths; no credentials or helper protocols.
[[ $repository =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$ \
  || $repository =~ ^git@github\.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ \
  || $repository == /* ]] || fail 'Use a GitHub HTTPS/SSH repository URL or an absolute local repository path.'
[[ -n $destination && ! -e $destination && ! -L $destination ]] || fail 'The destination folder must not exist.'
parent=$(cd -- "$(dirname -- "$destination")" && pwd -P)
destination=$parent/$(basename -- "$destination")
printf '%s\n' 'Cloning into a new local folder...'
git -c protocol.ext.allow=never clone --quiet -- "$repository" "$destination" \
  || fail 'Clone failed; inspect any remaining destination before retrying.'
cd -- "$destination"
[[ $(git rev-parse --is-inside-work-tree) == true ]] || fail 'A Git working tree is required.'
[[ $(pwd -P) == "$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)" ]] \
  || fail 'Pass the root of the backup clone.'
[[ -z $(git status --porcelain --untracked-files=all) ]] || fail 'The worktree and index must be clean.'
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [[ ! -e $(git rev-parse --git-path "$state") ]] || fail 'Finish the active Git operation first.'
done
[[ -f .ballin-backup.json && ! -L .ballin-backup.json ]] || fail 'A tracked Ballin backup marker is required.'
git ls-files --error-unmatch -- .ballin-backup.json >/dev/null 2>&1 \
  || fail 'A tracked Ballin backup marker is required.'
# Match the flat regular-file layout and canonical marker used by normal backup reads.
node <<'NODE' || fail 'The cloned default branch does not have a supported Ballin backup marker/layout.'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
try {
  const records = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const paths = new Set();
  for (const record of records) {
    const match = /^100644 [a-f0-9]{40,64} 0\t(.+)$/u.exec(record);
    if (!match || /[/\\\x00-\x1f\x7f]/u.test(match[1]) || ['.', '..', '.github'].includes(match[1]) || paths.has(match[1])) throw new Error();
    paths.add(match[1]);
  }
  if (fs.statSync('.ballin-backup.json').size > 4096) throw new Error();
  const bytes = fs.readFileSync('.ballin-backup.json');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || value.format !== 'ballin-backup' || value.version !== 1
    || ![value.repositoryId, value.ownerId].every(id => typeof id === 'string' && id && !/[\s\x00-\x1f\x7f]/u.test(id))) throw new Error();
  const canonical = JSON.stringify({ format: 'ballin-backup', version: 1, repositoryId: value.repositoryId, ownerId: value.ownerId }) + '\n';
  if (!bytes.equals(Buffer.from(canonical))) throw new Error();
} catch { process.exitCode = 1; }
NODE
old=(codex_profiles.json codex_skills.json codex_user_skills.json codex_rules.json codex_agents.json claude_rules claude_agents claude_commands)
new=(codex_profiles.bundle.json codex_skills.bundle.json codex_user_skills.bundle.json codex_rules.bundle.json codex_agents.bundle.json claude_rules.bundle.json claude_agents.bundle.json claude_commands.bundle.json)
selected=()
for i in "${!old[@]}"; do
  [[ -e ${old[$i]} || -L ${old[$i]} ]] || continue
  [[ ! -e ${new[$i]} && ! -L ${new[$i]} ]] || fail "Target already exists: ${new[$i]}"
  [[ -f ${old[$i]} && ! -L ${old[$i]} ]] || fail "Not a regular file: ${old[$i]}"
  entry=$(git ls-files --stage -- "${old[$i]}")
  [[ $entry == '100644 '* && $entry == *$' 0\t'* ]] || fail "Not a tracked regular backup file: ${old[$i]}"
  selected+=("$i")
done
next_steps() {
  printf '\n%s\n' 'Inspect the local clone:'
  printf 'git -C %q show\n' "$destination"
  printf '%s\n' 'After review, push the commit yourself:'
  printf 'git -C %q push\n' "$destination"
  printf '%s\n' 'Optionally remove this clone after inspection/push:'
  printf 'rm -rf -- %q\n' "$destination"
}
[[ ${#selected[@]} != 0 ]] || { printf '%s\n' 'No old bundle names to migrate; no commit created.'; next_steps; exit 0; }
# Resolve author/committer identity before staging anything. Repository hooks are not run.
git var GIT_AUTHOR_IDENT >/dev/null
git var GIT_COMMITTER_IDENT >/dev/null
for i in "${selected[@]}"; do git mv -- "${old[$i]}" "${new[$i]}"; done
if ! git -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -m 'Rename directory snapshots to .bundle.json'; then
  fail 'Commit failed; staged renames remain for inspection. Reconcile them before rerunning.'
fi
printf '%s\n' 'Created one local rename commit. Keep the old writer stopped; push the reviewed commit, update the writer, then resume backups.'
next_steps
