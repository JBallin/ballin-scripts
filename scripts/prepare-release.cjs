// Preparation only: never invokes Git, tags, publication, or deployment.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const args = process.argv.slice(2);
const check = args[0] === '--check';
const metadata = JSON.parse(read('release.json'));
if (!check && args.length) {
  if (args.length !== 2 || !['main', 'stable'].includes(args[1])) throw Error('Usage: node scripts/prepare-release.cjs VERSION main|stable | --check');
  metadata.version = args[0]; metadata.defaultTrack = args[1];
}
if (!/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(metadata.version) || !['main', 'stable'].includes(metadata.defaultTrack)) throw Error('Invalid release metadata');
const engine = JSON.parse(read('package.json')).engines.node;
const match = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(engine);
if (!match) throw Error('Unsupported minimum Node engine');
const minimumNode = `${match[1]}.${match[2]}.${match[3] || '0'}`;
const contract = JSON.stringify({ protocol: 1, minimumNode }, null, 2) + '\n';
const outputs = new Map([['release.json', JSON.stringify(metadata, null, 2) + '\n'], ['installer-contract.json', contract]]);
const shared = read('scripts/revision-bootstrap.sh').replace(/^#![^\n]*\n/, '').trimEnd();
for (const entry of ['install.sh', 'quickstart.sh']) {
  const block = `# BEGIN RELEASE BOOTSTRAP\nballin_entry='${entry}'\nballin_embedded_version='${metadata.version}'\nballin_default_track='${metadata.defaultTrack}'\n${shared}\n# END RELEASE BOOTSTRAP`;
  const source = read(entry);
  outputs.set(entry, source.includes('# BEGIN RELEASE BOOTSTRAP')
    ? source.replace(/# BEGIN RELEASE BOOTSTRAP[\s\S]*?# END RELEASE BOOTSTRAP/, block)
    : source.replace('{ # Parse the complete body before starting installation.', '{ # Parse the complete body before starting installation.\n' + block));
}
for (const doc of ['README.md', 'docs/quickstart.md', 'docs/installation.md']) {
  outputs.set(doc, read(doc).replace(/(raw\.githubusercontent\.com\/JBallin\/ballin-scripts\/)(?:main|v\d+\.\d+\.\d+)(\/(?:install|quickstart)\.sh)/g,
    `$1${metadata.defaultTrack === 'main' ? 'main' : 'v' + metadata.version}$2`));
}
for (const [file, content] of outputs) {
  if (check) { if (!fs.existsSync(path.join(root,file)) || read(file) !== content) throw Error(`Release preparation is stale: ${file}`); }
  else fs.writeFileSync(path.join(root,file), content);
}
process.stdout.write(`${check ? 'Verified' : 'Prepared'} ${metadata.version}, ${metadata.defaultTrack} default, Node >=${minimumNode}. No tag or release was created.\n`);
