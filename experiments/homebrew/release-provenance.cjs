// Experimental read-only publication collection. Never installs or publishes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const api = 'https://api.github.com/repos/JBallin/ballin-scripts';
const tagPattern = /^v(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const shaPattern = /^[a-f0-9]{40}$/;
const verified = new WeakSet();
const archiveUrl = sha => `https://codeload.github.com/JBallin/ballin-scripts/tar.gz/${sha}`;
async function download(url, { limit, timeout = 60000 }) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'ballin-release-experiment', Accept: 'application/vnd.github+json' } });
  if (response.status !== 200) throw Error(`Download failed (HTTP ${response.status}): ${url}`);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw Error(`Download exceeds ${limit} bytes: ${url}`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { throw Error(`Download failed: ${url}: ${error.message}`); }
  return Buffer.concat(chunks);
}
async function collectRelease({ tag, destination, formula, transport = download }) {
  if (typeof formula !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/ballin-experiment$/.test(formula)) throw Error('Use an explicit qualified experimental formula owner/tap/ballin-experiment.');
  if (!tagPattern.test(tag || '')) throw Error('Use an exact stable release tag vX.Y.Z.');
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw Error('Use an explicit absolute new output directory.');
  // Exclusive creation: never replace an earlier successful or interrupted collection.
  fs.mkdirSync(destination, { mode: 0o700 });
  const get = async (url, limit) => {
    const data = await transport(url, { limit, timeout: 60000 });
    if (!Buffer.isBuffer(data) || !data.length || data.length > limit) throw Error('Invalid or oversized download.');
    return data;
  };
  const json = async url => JSON.parse((await get(url, 1024 * 1024)).toString('utf8'));
  const identity = async () => {
    const release = await json(`${api}/releases/tags/${tag}`);
    if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false
      || !Number.isSafeInteger(release.id) || release.id < 1
      || typeof release.published_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(release.published_at) || !Number.isFinite(Date.parse(release.published_at))) throw Error('Selected release is not a valid published stable release.');
    let object = (await json(`${api}/git/ref/tags/${tag}`)).object;
    let depth = 0;
    while (object?.type === 'tag' && depth < 8) {
      if (!shaPattern.test(object.sha)) throw Error('Invalid annotated tag SHA.');
      object = (await json(`${api}/git/tags/${object.sha}`)).object;
      depth++;
    }
    if (object?.type !== 'commit' || !shaPattern.test(object.sha)) throw Error('Release tag does not resolve to a commit within eight hops.');
    return { releaseId: String(release.id), sha: object.sha };
  };
  try {
    const before = await identity();
    const bytes = await get(archiveUrl(before.sha), 32 * 1024 * 1024);
    const archive = path.join(destination, 'source.tar.gz');
    fs.writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    // Reuse the existing archive checks; this does not run the resulting formula.
    execFileSync(process.execPath, [path.join(__dirname, 'generate-formula.cjs'), '--archive', archive, '--sha256', checksum, '--source-sha', before.sha], { timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = args => execFileSync('/usr/bin/tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
    const root = tar(['-tf', archive]).split('/')[0];
    const metadata = JSON.parse(tar(['-xOf', archive, `${root}/package.json`]));
    if (metadata.ballin?.packageSchema !== 3) throw Error('Selected release does not support package provenance schema 3.');
    if (`v${metadata.version}` !== tag) throw Error('Archive package version does not match the published release tag.');
    const engine = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(metadata.engines.node);
    const minimumNode = `${engine[1]}.${engine[2]}.${engine[3] || '0'}`;
    const nodeMajor = Number(tar(['-xOf', archive, `${root}/.nvmrc`]).trim());
    if (!/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(minimumNode) || !Number.isSafeInteger(nodeMajor) || nodeMajor < Number(engine[1])) throw Error('Unsupported stable runtime contract.');
    const after = await identity();
    if (before.releaseId !== after.releaseId || before.sha !== after.sha) throw Error('Release identity changed during collection.');
    const result = Object.freeze({ formula, archive, archiveUrl: archiveUrl(before.sha), archiveSha256: checksum, sourceRevision: before.sha,
      version: metadata.version, minimumNode, nodeMajor, selection: Object.freeze({ kind: 'release', value: tag, releaseId: before.releaseId }) });
    verified.add(result);
    fs.writeFileSync(path.join(destination, 'ballin-experiment.rb'), require('./generate-formula.cjs').generate({ verifiedRelease: result, formula }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) { throw Error(`Release collection failed; inspect incomplete output at ${destination}: ${error.message}`); }
}
const isVerifiedRelease = value => verified.has(value);
if (require.main === module) {
  if (process.argv.length !== 5) { process.stderr.write('Use: node release-provenance.cjs vX.Y.Z NEW_ABSOLUTE_OUTPUT_DIRECTORY OWNER/TAP/ballin-experiment\n'); process.exitCode = 1; }
  else collectRelease({ tag: process.argv[2], destination: process.argv[3], formula: process.argv[4] }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = { collectRelease, isVerifiedRelease };
