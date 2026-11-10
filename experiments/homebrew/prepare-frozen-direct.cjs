// Explicit local experiment transport. Never publishes or runs an installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const files = ['package.json', 'quickstart.sh', 'install.sh', 'commands/repo_update.ts'];
function prepare(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
  const git = args => cp.execFileSync('git', ['-C', source, ...args], { env, encoding: 'utf8' });
  if (git(['status', '--porcelain', '--untracked-files=all']).trim()) throw Error('Commit the candidate first; the source worktree must be clean.');
  if (git(['for-each-ref', '--format=%(refname)', 'refs/replace/']).trim()) throw Error('Git replacement refs are unsupported.');
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Expected a full SHA-1 commit.');
  // Never replace a previous artifact; its manifest is evidence for that run.
  fs.mkdirSync(destination);
  try {
    git(['bundle', 'create', path.join(destination, 'source.bundle'), 'HEAD']);
    git(['archive', '--format=tar.gz', '--prefix=ballin-scripts/', '--output=' + path.join(destination, 'source.tar.gz'), sha]);
    for (const file of files) {
      const target = path.join(destination, 'bootstrap', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, git(['show', `${sha}:${file}`]));
    }
    fs.writeFileSync(path.join(destination, 'source-sha'), sha + '\n');
    const members = ['source-sha', 'source.bundle', 'source.tar.gz', ...files.map(file => 'bootstrap/' + file)];
    fs.writeFileSync(path.join(destination, 'SHA256SUMS'), members.map(file => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, file))).digest('hex');
      return `${hash}  ${file}\n`;
    }).join(''));
    return { sha, destination, archive: path.join(destination, 'source.tar.gz') };
  } catch (error) {
    // Retain a failed preparation for inspection; it will not pass verification.
    throw Error(`Preparation failed; inspect the incomplete artifact at ${destination}: ${error.message}`);
  }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Use: node prepare-frozen-direct.cjs SOURCE_REPO NEW_ARTIFACT_DIR');
    process.stdout.write(JSON.stringify(prepare(...process.argv.slice(2))) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { prepare };
