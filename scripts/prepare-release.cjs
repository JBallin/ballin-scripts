// Preparation only: never invokes Git, tags, publication, or deployment.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';
if (!check && (args.length > 1 || args[0]?.startsWith('-'))) throw Error('Usage: node scripts/prepare-release.cjs [VERSION] | --check');
const metadata = JSON.parse(read('package.json'));
const version = !check && args.length ? args[0] : metadata.version;
if (!/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(version)) throw Error('Invalid release version');
if (metadata.ballin?.installerProtocol !== 2) throw Error('Unsupported installer protocol');
const match = /^>=(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2}))?$/.exec(metadata.engines?.node);
if (!match) throw Error('Unsupported minimum Node engine');
const minimumNode = `${match[1]}.${match[2]}.${match[3] || '0'}`;
metadata.version = version;
const lock = JSON.parse(read('package-lock.json'));
if (!lock.packages?.[''] || lock.name !== metadata.name || lock.packages[''].name !== metadata.name) throw Error('Invalid root package lock');
lock.version = version;
lock.packages[''].version = version;
const outputs = new Map([
  ['package.json', JSON.stringify(metadata, null, 2) + '\n'],
  ['package-lock.json', JSON.stringify(lock, null, 2) + '\n'],
]);
const shared = read('scripts/revision-bootstrap.sh').replace(/^#![^\n]*\n/, '').trimEnd();
for (const entry of ['install.sh', 'quickstart.sh']) {
  const block = `# BEGIN RELEASE BOOTSTRAP\nballin_entry='${entry}'\nballin_embedded_version='${version}'\n${shared}\n# END RELEASE BOOTSTRAP`;
  const source = read(entry);
  outputs.set(entry, source.includes('# BEGIN RELEASE BOOTSTRAP')
    ? source.replace(/# BEGIN RELEASE BOOTSTRAP[\s\S]*?# END RELEASE BOOTSTRAP/, () => block)
    : source.replace('{ # Parse the complete body before starting installation.', () => '{ # Parse the complete body before starting installation.\n' + block));
}
for (const doc of ['README.md', 'docs/quickstart.md', 'docs/installation.md']) {
  // Until a first release exists, explicit main-prefixed commands stay runnable.
  // Preparing a version is the reviewed transition to versioned entrypoint URLs.
  const content = read(doc).split('\n').map(line => {
    const temporaryMain = line.includes('BALLIN_UPDATE_TRACK=main ');
    if (temporaryMain && (!args.length || check)) return line;
    const released = temporaryMain ? line.replace('BALLIN_UPDATE_TRACK=main ', '') : line;
    return released.replace(/(raw\.githubusercontent\.com\/JBallin\/ballin-scripts\/)(?:main|v\d+\.\d+\.\d+)(\/(?:install|quickstart)\.sh)/g, `$1v${version}$2`);
  }).join('\n');
  outputs.set(doc, content);
}
for (const [file, content] of outputs) {
  if (check) { if (!fs.existsSync(path.join(root, file)) || read(file) !== content) throw Error(`Release preparation is stale: ${file}`); }
  else fs.writeFileSync(path.join(root, file), content);
}
process.stdout.write(`${check ? 'Verified' : 'Prepared'} ${version}, stable default, Node >=${minimumNode}. No tag or release was created.\n`);
