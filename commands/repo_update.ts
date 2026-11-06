// This helper is also downloaded by exact commit before installation. Keep it standalone.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

type Selection = { kind: 'release' | 'branch' | 'sha'; value: string; sha: string; minimumNode: string; releaseId: string };
type Identity = { sha?: string; label: string; version: string; kind?: Selection['kind']; value?: string; dirty?: boolean };
const repository = 'https://github.com/JBallin/ballin-scripts.git';
const shaPattern = /^[a-f0-9]{40}$/u;
const versionPattern = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u;
const commandEnv = (cwd: string): NodeJS.ProcessEnv => ({ ...process.env, PWD: cwd, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });
const git = (root: string, args: string[], allowFailure = false): string => {
  const result = cp.spawnSync('git', args, { cwd: root, env: commandEnv(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.signal || result.status === 130 || result.status === 143) {
    throw Object.assign(new Error('Git operation interrupted.'), { status: result.signal === 'SIGTERM' || result.status === 143 ? 143 : 130 });
  }
  if (result.error || result.status !== 0) {
    if (allowFailure) return '';
    throw new Error(`Git ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || 'unknown error'}`);
  }
  if (args[0] === 'fetch' && result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trimEnd();
};
const isAncestor = (root: string, before: string, after: string): boolean => {
  const result = cp.spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd: root, env: commandEnv(root), stdio: 'ignore' });
  if (result.signal || result.status === 130 || result.status === 143) throw Object.assign(new Error('Git operation interrupted.'), { status: result.signal === 'SIGTERM' || result.status === 143 ? 143 : 130 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Could not verify checkout ancestry. Inspect the checkout before retrying.');
  return result.status === 0;
};
const validateSelection = (s: Selection): void => {
  if (!['release', 'branch', 'sha'].includes(s.kind) || !shaPattern.test(s.sha) || !versionPattern.test(s.minimumNode)
    || typeof s.value !== 'string' || /[\x00-\x20\x7f]/u.test(s.value) || !s.value
    || (s.kind === 'release' && (!versionPattern.test(s.value.slice(1)) || !s.value.startsWith('v') || !/^[1-9]\d*$/u.test(s.releaseId)))
    || (s.kind === 'sha' && s.value !== s.sha)
    || (s.kind !== 'release' && s.releaseId !== '-')) throw new Error('Invalid resolved installation selection.');
};
const compareVersions = (a: string, b: string): number => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};
const checkRuntime = (minimum: string, actual = process.versions.node): void => {
  if (!versionPattern.test(minimum) || !versionPattern.test(actual) || compareVersions(actual, minimum) < 0) {
    throw new Error(`Selected revision requires Node.js ${minimum} or newer; active Node.js is ${actual}. Upgrade or activate Node.js, then retry. The checkout has not changed.`);
  }
};
// Resolve the worktree's metadata directory through Git, without resolving the receipt leaf symlink.
const receiptPath = (root: string): string => path.join(git(root, ['rev-parse', '--absolute-git-dir']), 'ballin-install.json');
const receiptSnapshot = (root: string): string => {
  try {
    const file = receiptPath(root), stat = fs.lstatSync(file);
    return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() && stat.size <= 4096 ? fs.readFileSync(file, 'utf8') : null]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
};
const readReceipt = (root: string): Selection => {
  const file = receiptPath(root);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid installation receipt.');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as Selection;
  validateSelection(receipt);
  return receipt;
};
const selectionLabel = (s: Selection): string => s.kind === 'release' ? s.value : s.kind === 'sha' ? `commit ${s.sha.slice(0, 12)}` : `branch ${s.value} (${s.sha.slice(0, 12)})`;
const readIdentity = (root: string): Identity => {
  try {
    const sha = git(root, ['rev-parse', '--verify', 'HEAD']);
    if (!shaPattern.test(sha)) return { label: 'unknown revision', version: 'unknown' };
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=normal']) !== ''
      || git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/']) !== ''
      || git(root, ['config', '--get', 'core.sparseCheckout'], true) === 'true'
      || git(root, ['ls-files', '-v']).split('\n').some((line: string) => /^[a-zS]/u.test(line));
    const development: Identity = { sha, label: `development ${sha.slice(0, 12)}${dirty ? ' (dirty)' : ''}`, version: 'development', dirty };
    try {
      const receipt = readReceipt(root);
      if (receipt.sha !== sha) return development;
      if (receipt.kind !== 'release') return { ...development, label: `${selectionLabel(receipt)}${dirty ? ' (dirty)' : ''}`, kind: receipt.kind, value: receipt.value };
      if (dirty || git(root, ['rev-parse', '--verify', `refs/tags/${receipt.value}^{commit}`], true) !== sha) return development;
      return { sha, label: receipt.value, version: receipt.value.slice(1), kind: 'release', value: receipt.value, dirty: false };
    } catch (error) { if ((error as { status?: number }).status) throw error; return development; }
  } catch (error) { if ((error as { status?: number }).status) throw error; return { label: 'unknown revision', version: 'unknown' }; }
};
const assertSafeCheckout = (root: string): string => {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Installation directory must be a real directory.');
  if (fs.realpathSync(root) !== fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']))) throw new Error('Installation is not the repository root.');
  const origin = git(root, ['remote', 'get-url', 'origin']);
  if (![repository, 'git@github.com:JBallin/ballin-scripts.git', 'https://github.com/JBallin/ballin-scripts'].includes(origin)) throw new Error('Installation origin is not the Ballin repository. Inspect it before retrying.');
  if (git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])) throw new Error('Checkout has Git replacement refs. Inspect them before retrying; Ballin will not change them.');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'index.lock']) {
    if (fs.existsSync(git(root, ['rev-parse', '--path-format=absolute', '--git-path', name]))) throw new Error(`Checkout has ${name}; finish or inspect that operation before retrying.`);
  }
  if (git(root, ['config', '--get', 'core.sparseCheckout'], true) === 'true'
    || git(root, ['ls-files', '-v']).split('\n').some((line: string) => /^[a-zS]/u.test(line))) throw new Error('Sparse or hidden index state is unsupported. Inspect the checkout before retrying.');
  if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Checkout contains local changes. Preserve them before retrying; Ballin will not stash or reset them.');
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!git(root, ['symbolic-ref', '-q', 'HEAD'], true) && !git(root, ['for-each-ref', '--contains', head, '--format=%(refname)'])) {
    const identity = readIdentity(root);
    if (identity.sha !== head || !identity.kind) throw new Error('Detached checkout has unprotected work. Create a branch for it before retrying.');
  }
  return head;
};
const needsConsent = (before: Identity, s: Selection, mode: string): boolean => {
  if (before.sha === s.sha && before.kind === s.kind && before.value === s.value) return false;
  if (mode !== 'self-update') return before.sha !== s.sha || before.kind !== s.kind || before.value !== s.value;
  if (before.kind === 'branch' && before.value === 'main' && s.kind === 'branch' && s.value === 'main') return false;
  if (before.kind !== 'release' || s.kind !== 'release') return true;
  return compareVersions(s.value.slice(1), before.version) < 0 || s.value.split('.')[0] !== before.value?.split('.')[0];
};
const revisionCancelledStatus = 20;
// This downloaded helper remains standalone; mirror the shared prompt's
// read-only layout checks without depending on the installed checkout's code.
type SelectionPromptLayout = { rows: number; columns: number; echo: boolean };
const selectionPromptLayout = (): SelectionPromptLayout | undefined => {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb' || process.env.NO_COLOR || !require('node:tty').isatty(0)) return;
  try {
    const input = fs.fstatSync(0), output = fs.fstatSync(1);
    if (!input.isCharacterDevice() || !output.isCharacterDevice() || input.rdev !== output.rdev) return;
    const result = cp.spawnSync('/bin/stty', ['-a'], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000 });
    if (result.error) return;
    if (result.signal || result.status === 130 || result.status === 143) throw Object.assign(new Error('Revision confirmation interrupted.'), { status: result.signal === 'SIGTERM' || result.status === 143 ? 143 : 130 });
    if (result.status !== 0) return;
    const flags = result.stdout;
    const row = /\brows\s*=?\s*(\d+)|(\d+)\s+rows\b/u.exec(flags);
    const column = /\bcolumns\s*=?\s*(\d+)|(\d+)\s+columns\b/u.exec(flags);
    const echo = /(?:^|[\s;])(-?echo)(?=[\s;]|$)/u.exec(flags);
    if (!row || !column || !echo || !/(?:^|[\s;])icanon(?=[\s;]|$)/u.test(flags)
      || !/(?:^|[\s;])onlcr(?=[\s;]|$)/u.test(flags)) return;
    const rows = Number(row[1] || row[2]), columns = Number(column[1] || column[2]);
    if (rows > 1 && columns > 0) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BASH_FUNC_')));
      const readiness = cp.spawnSync('/bin/zsh', ['-d', '-f', '-c', 'zmodload zsh/zselect || exit 2; zselect -r 0 -t 0'], {
        env: { ...env, BASH_ENV: '', ENV: '', ZDOTDIR: '' }, stdio: [0, 'ignore', 'ignore'], timeout: 1000,
      });
      if (readiness.error) return;
      if (readiness.signal || readiness.status === 130 || readiness.status === 143) throw Object.assign(new Error('Revision confirmation interrupted.'), { status: readiness.signal === 'SIGTERM' || readiness.status === 143 ? 143 : 130 });
      if (readiness.status === 1) return { rows, columns, echo: echo[1] === 'echo' };
    }
  } catch (error) { if ((error as { status?: number }).status) throw error; }
};
// Keep this downloaded helper standalone; mirror terminalCommand's stderr policy.
const stderrCommand = (command: string): string => process.stderr.isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR
  ? `\x1b[1m${command}\x1b[0m` : `\`${command}\``;
class RevisionChangeCancelled extends Error {}
class RevisionChangeRequiresConfirmation extends Error { status = 21; }
const confirmTransition = (before: Identity, selection: Selection, mode: string): void => {
  process.stdout.write(`Ballin: ${before.label} → ${selectionLabel(selection)}\n`);
  if (selection.kind === 'release') process.stdout.write(`Release notes: https://github.com/JBallin/ballin-scripts/releases/tag/${selection.value}\n`);
  if (!needsConsent(before, selection, mode)) return;
  if (process.env.BALLIN_AUTOMATIC_UPDATE === '1' || !require('node:tty').isatty(0)) {
    if (mode === 'self-update') throw new RevisionChangeRequiresConfirmation(`Confirmation required. Run ${stderrCommand('ballin self-update')} manually to continue.`);
    throw new RevisionChangeRequiresConfirmation('This revision/track change requires confirmation. The requested revision was not applied. `ballin self-update` follows the default selection; it cannot select an explicit revision.');
  }
  const styled = process.stdout.isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR;
  const plainPrompt = '? Change the installed revision/track? [y/N] ';
  const rendered = styled
    ? '\x1b[1;32m?\x1b[0m Change the installed revision/track? [y/N] '
    : plainPrompt;
  while (true) {
    const layout = selectionPromptLayout();
    process.stdout.write(rendered);
    const byte = Buffer.alloc(1); let answer = ''; let complete = false; let overflow = false;
    while (fs.readSync(0, byte, 0, 1, null)) { if (byte[0] === 10) { complete = true; break; } if (answer.length < 32) answer += byte.toString(); else overflow = true; }
    if (layout?.echo === false) process.stdout.write('\n');
    const normalized = answer.trim().toLowerCase();
    const label = /^(?:y|yes)$/u.test(normalized) ? 'Yes' : /^(?:n|no)?$/u.test(normalized) ? 'No' : undefined;
    if (complete && !overflow && label && layout && /^[\x20-\x7e]*$/u.test(answer)) {
      const current = selectionPromptLayout();
      const rows = Math.max(1, Math.ceil((plainPrompt.length + (layout.echo ? answer.length : 0)) / layout.columns));
      if (current && current.rows === layout.rows && current.columns === layout.columns && current.echo === layout.echo && rows < layout.rows) {
        process.stdout.write(`\x1b[${rows}A\r\x1b[J${rendered}\x1b[36m${label}\x1b[0m\n`);
      }
    }
    if (!complete) throw new RevisionChangeCancelled('Revision change cancelled. The installed checkout is unchanged.');
    if (overflow || !label) { process.stdout.write('Enter Yes or No.\n'); continue; }
    if (label === 'No') throw new RevisionChangeCancelled('Revision change cancelled. The installed checkout is unchanged.');
    return;
  }
};
const verifySelectedContract = (root: string, selection: Selection): void => {
  const contract = JSON.parse(git(root, ['show', `${selection.sha}:package.json`]));
  const engine = typeof contract.engines?.node === 'string' ? /^>=(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2}))?$/u.exec(contract.engines.node) : null;
  const minimumNode = engine ? `${engine[1]}.${engine[2]}.${engine[3] ?? '0'}` : undefined;
  if (contract.ballin?.installerProtocol !== 2 || minimumNode !== selection.minimumNode) throw new Error('Selected installer contract changed or is unsupported.');
  checkRuntime(minimumNode);
};
const applySelection = (root: string, selection: Selection, mode: string, fresh = false): void => {
  validateSelection(selection); checkRuntime(selection.minimumNode);
  let head: string | undefined;
  if (!fresh) head = assertSafeCheckout(root);
  // Fetch the immutable object, never a moving branch or a force-updated tag.
  git(root, ['fetch', '--no-tags', repository, selection.sha]);
  if (git(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']) !== selection.sha) throw new Error('Fetched revision does not match selection.');
  verifySelectedContract(root, selection);
  for (const entry of ['install.sh', 'quickstart.sh', 'commands/repo_update.ts', 'commands/install_setup.ts', 'bin/ballin', 'package.json']) {
    const treeEntry = git(root, ['ls-tree', selection.sha, '--', entry]);
    if (!/^(100644|100755) blob [a-f0-9]{40}\t/u.test(treeEntry)) throw new Error(`Selected revision lacks a supported installer file: ${entry}. The checkout has not changed.`);
  }
  const beforeReceipt = fresh ? undefined : receiptSnapshot(root);
  if (!fresh) {
    const before = readIdentity(root);
    if (mode === 'self-update' && before.kind === 'branch' && before.value === 'main' && selection.kind === 'branch' && selection.value === 'main') {
      if (!isAncestor(root, head!, selection.sha)) throw new Error('Main has diverged or moved backward. Preserve local work and inspect the checkout before retrying `ballin self-update`.');
    }
    confirmTransition(before, selection, mode);
  }
  if (!fresh && (assertSafeCheckout(root) !== head || receiptSnapshot(root) !== beforeReceipt)) throw new Error('Checkout changed after confirmation. Retry after inspecting it.');
  if (selection.kind === 'release') {
    const tag = git(root, ['rev-parse', '--verify', `refs/tags/${selection.value}^{commit}`], true);
    if (tag && tag !== selection.sha) throw new Error('Existing release tag conflicts with the selected release.');
    if (!tag) {
      git(root, ['fetch', '--no-tags', repository, `refs/tags/${selection.value}:refs/tags/${selection.value}`]);
      if (git(root, ['rev-parse', '--verify', `refs/tags/${selection.value}^{commit}`]) !== selection.sha) throw new Error('Release tag moved after resolution.');
    }
  }
  checkRuntime(selection.minimumNode);
  if (!fresh && (assertSafeCheckout(root) !== head || receiptSnapshot(root) !== beforeReceipt)) throw new Error('Checkout changed before transition.');
  if (!fresh && selection.kind === 'branch' && selection.value === 'main' && git(root, ['symbolic-ref', '-q', 'HEAD'], true) === 'refs/heads/main'
    && isAncestor(root, head!, selection.sha)) {
    git(root, ['merge', '--ff-only', '--no-overwrite-ignore', selection.sha]);
  } else git(root, ['checkout', '--detach', '--no-overwrite-ignore', selection.sha]);
  if (git(root, ['rev-parse', 'HEAD']) !== selection.sha) throw new Error('Installed revision verification failed.');
  const file = receiptPath(root), temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(selection) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  catch (error) {
    const recovery = fresh ? 'Inspect the Git metadata and rerun the installer.'
      : mode === 'self-update' ? 'Inspect the Git metadata and run `ballin self-update` again.'
        : 'Inspect the Git metadata before continuing. `ballin self-update` follows the default selection; it cannot restore an explicit selection.';
    throw new Error(`Checkout is now ${selection.sha}, but installation provenance could not be saved and setup is incomplete. ${recovery} ${(error as Error).message}`);
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  process.stdout.write(`Selected ${selectionLabel(selection)}\n`);
};
const canonicalInstallationRoot = (root: string): string => {
  assertSafeCheckout(root);
  const canonical = fs.realpathSync(root);
  if (canonical !== fs.realpathSync(path.join(process.env.HOME ?? '', '.ballin-scripts'))) throw new Error('Self-update installation root does not match HOME.');
  return canonical;
};
const assertAppliedSelection = (root: string, selection: Selection): void => {
  validateSelection(selection); checkRuntime(selection.minimumNode);
  if (root !== canonicalInstallationRoot(root) || git(root, ['rev-parse', '--verify', 'HEAD']) !== selection.sha) throw new Error('Applied-update checkout does not match the selected revision.');
  const receipt = readReceipt(root);
  if (Object.keys(selection).some(key => receipt[key as keyof Selection] !== selection[key as keyof Selection])) throw new Error('Applied-update receipt does not match the selected revision.');
  verifySelectedContract(root, selection);
  if (selection.kind === 'release' && git(root, ['rev-parse', '--verify', `refs/tags/${selection.value}^{commit}`]) !== selection.sha) throw new Error('Applied-update release tag does not match.');
};
const applyAndRefresh = (root: string, selection: Selection, commandPreflight: string): void => {
  const canonical = canonicalInstallationRoot(root);
  try {
    const preflight = JSON.parse(commandPreflight), snapshot = JSON.parse(preflight.snapshot);
    if (typeof preflight.directory !== 'string' || !path.isAbsolute(preflight.directory)
      || preflight.target !== path.join(preflight.directory, 'ballin')
      || (snapshot !== null && (!['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(snapshot[key]))
        || (snapshot.link !== null && typeof snapshot.link !== 'string')))) throw new Error();
  } catch { throw new Error('Invalid command preflight for self-update. The checkout has not changed.'); }
  applySelection(canonical, selection, 'self-update');
  const incomplete = (status: number): void => {
    process.stderr.write(`Ballin checkout is now ${selection.sha}, but setup refresh failed. Fix the reported error, then run ${stderrCommand('ballin self-update')} to finish.\n`);
    process.exitCode = status;
  };
  try {
    assertAppliedSelection(canonical, selection);
    const result = cp.spawnSync('/bin/bash', [path.join(canonical, 'install.sh'), '--ballin-applied-v2', canonical,
      selection.kind, selection.value, selection.sha, selection.minimumNode, selection.releaseId, commandPreflight], {
      cwd: canonical, env: { ...commandEnv(canonical), BASH_ENV: '', ENV: '' }, stdio: 'inherit',
    });
    if (result.signal || result.status === 130 || result.status === 143) throw Object.assign(new Error('Update interrupted.'), { status: result.signal === 'SIGTERM' || result.status === 143 ? 143 : 130 });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.error || result.status !== 0) incomplete(result.status || 1);
  } catch (error) {
    if ([130, 143].includes((error as { status?: number }).status ?? 0)) throw error;
    process.stderr.write(`${(error as Error).message}\n`);
    incomplete(1);
  }
};
const updateInstalledRepo = (root: string): boolean | 'cancelled' => {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { process.stdout.write(`install directory not found: ${root}\n`); return false; }
  const result = cp.spawnSync('bash', [path.join(root, 'install.sh'), '--self-update'], { cwd: root, env: commandEnv(root), stdio: 'inherit' });
  if (result.signal || result.status === 130 || result.status === 143) throw Object.assign(new Error('Update interrupted.'), { status: result.signal === 'SIGTERM' || result.status === 143 ? 143 : 130 });
  if (result.error) throw new Error(`Unable to start the installed updater: ${result.error.message}`);
  if (result.status === revisionCancelledStatus) return 'cancelled';
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
};
const runRepoUpdateCli = (): void => {
  const [, , action, root, kind, value, sha, minimumNode, releaseId, mode, fresh] = process.argv;
  try {
    if (action === 'inspect') { assertSafeCheckout(root); return; }
    const selection = { kind: kind as Selection['kind'], value, sha, minimumNode, releaseId };
    if (action === 'verify-applied') { assertAppliedSelection(root, selection); return; }
    if (action === 'self-update') { applyAndRefresh(root, selection, mode); return; }
    if (action !== 'apply') throw new Error('Usage: repo_update.ts inspect <root> | apply <root> <kind> <value> <sha> <minimum-node> <release-id> <mode> <fresh>');
    applySelection(root, selection, mode, fresh === 'true');
  } catch (error) {
    if (error instanceof RevisionChangeCancelled) {
      process.stdout.write(`${error.message}\n`);
      process.exitCode = revisionCancelledStatus;
    } else {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = (error as { status?: number }).status || 1;
    }
  }
};
if (require.main === module) runRepoUpdateCli();
module.exports = { commandEnv, readIdentity, validateSelection, compareVersions, checkRuntime, assertSafeCheckout, needsConsent, applySelection, assertAppliedSelection, updateInstalledRepo, runRepoUpdateCli };

export type { Identity };
