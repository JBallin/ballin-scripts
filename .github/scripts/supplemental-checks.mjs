import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const relevant = (name) => /^(?:\.github\/|test\/ci\/)/u.test(name)
  || /^(?:test\/(?:claude_workflows\.test\.ts|supplemental_checks\.test\.ts|setup\.ts|helpers\/environment\.ts)|config\/\.defaultConfig\.json|package(?:-lock)?\.json|\.mocharc\.[^/]*|\.nvmrc|\.npmrc)$/u.test(name);

// Compare the tree actually tested, including base-side changes in PR merges.
// Any uncertainty keeps the supplemental checks enabled.
export function selectChecks(eventName, event, sha, git) {
  try {
    const validSha = (value) => typeof value === 'string'
      && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
    const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
      : eventName === 'push' ? event.before : undefined;
    if (!validSha(base) || !validSha(sha)) return true;
    if (git(['rev-parse', 'HEAD']).toString().trim() !== sha) return true;
    if (eventName === 'pull_request'
      && git(['rev-parse', 'HEAD^1']).toString().trim() !== base) return true;
    try {
      git(['cat-file', '-e', `${base}^{commit}`]);
    } catch {
      git(['fetch', '--no-tags', '--depth=1', 'origin', base]);
    }
    const changed = git(['diff', '--name-only', '-z', '--no-renames', base, sha, '--']);
    return changed.toString('utf8').split('\0').some(relevant);
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let run = true;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    run = selectChecks(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA,
      (args) => execFileSync('git', args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { /* Unavailable event data also runs the checks. */ }
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}
