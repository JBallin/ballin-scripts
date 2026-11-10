// Local experiment only. Reads an explicit archive; never installs or publishes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const rubyString = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const required = ['package.json', '.nvmrc', 'bin/ballin', 'commands/ballin.ts', 'commands/installation.ts', 'config/.defaultConfig.json', 'completions/_ballin', 'completions/ballin.bash'];
function generate({ archive, checksum, sourceRevision, nodeMajor, verifiedRelease, formula = verifiedRelease?.formula ?? 'ballin-experiment' }) {
  if (verifiedRelease !== undefined) {
    if (!require('./release-provenance.cjs').isVerifiedRelease(verifiedRelease)) throw Error('Stable generation requires an in-process verified release collection, not supplied JSON.');
    if ([archive, checksum, sourceRevision, nodeMajor].some(value => value !== undefined)) throw Error('Verified release identity and runtime cannot be overridden.');
    ({ archive, sourceRevision, nodeMajor } = verifiedRelease);
    checksum = verifiedRelease.archiveSha256;
  }
  if (!/^(?:[a-z0-9-]+\/[a-z0-9-]+\/)?ballin-experiment$/.test(formula)) throw Error('Invalid experimental formula identity.');
  if (!archive || !path.isAbsolute(archive)) throw Error('Archive must be an explicit absolute local path.');
  if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw Error('Expected a lowercase SHA256 checksum.');
  if (!/^[a-f0-9]{40}$/.test(sourceRevision || '')) throw Error('Expected a full lowercase source commit SHA.');
  if (!fs.statSync(archive).isFile()) throw Error('Archive must be a file.');
  if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== checksum) throw Error('Archive checksum mismatch.');
  const tar = args => execFileSync('/usr/bin/tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  const entries = tar(['-tf', archive]).trimEnd().split('\n');
  if (entries.some(entry => !/^[A-Za-z0-9_.@/-]+$/.test(entry) || entry.startsWith('/') || entry.split('/').some(part => part === '..' || part === '.'))) throw Error('Unsafe archive member path.');
  const root = entries[0].split('/')[0];
  if (entries.some(entry => !entry.startsWith(`${root}/`)) || new Set(entries).size !== entries.length) throw Error('Archive must have one unique top-level source directory.');
  // Do not accept links/devices: the formula later extracts this exact archive.
  if (tar(['-tvf', archive]).trimEnd().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw Error('Archive must contain only regular files and directories.');
  for (const file of required) if (!entries.includes(`${root}/${file}`)) throw Error(`Missing archive runtime file: ${file}`);
  if (entries.includes(`${root}/.ballin-package.json`)) throw Error('Archive must not contain a package ownership marker.');
  const read = file => tar(['-xOf', archive, `${root}/${file}`]);
  const metadata = JSON.parse(read('package.json'));
  if (metadata.name !== 'ballin-scripts' || !semver.test(metadata.version) || metadata.ballin?.installerProtocol !== 2) throw Error('Unsupported Ballin package metadata.');
  if (Object.keys(metadata.dependencies || {}).length) throw Error('Runtime npm dependencies require a new packaging design.');
  const engine = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(metadata.engines?.node || '');
  if (!engine) throw Error('Unsupported Node runtime requirement.');
  const minimum = `${engine[1]}.${engine[2]}.${engine[3] || '0'}`;
  const testedMajor = read('.nvmrc').trim();
  if (!/^[1-9]\d*$/.test(testedMajor)) throw Error('Archive .nvmrc must name a Node major.');
  const major = String(nodeMajor ?? testedMajor);
  if (!/^[1-9]\d*$/.test(major) || Number(major) < Number(engine[1])) throw Error('Node dependency is below the required runtime major.');
  const marker = { manager: 'homebrew', formula, schema: 2, version: metadata.version, sourceRevision, archiveSha256: checksum, selection: { kind: 'development' } };
  if (verifiedRelease) {
    if (metadata.ballin?.packageSchema !== 3) throw Error('Selected release does not support package provenance schema 3.');
    if (formula !== verifiedRelease.formula) throw Error('Verified release formula owner cannot be overridden.');
    if (metadata.version !== verifiedRelease.version || minimum !== verifiedRelease.minimumNode || Number(major) !== verifiedRelease.nodeMajor) throw Error('Verified release archive contract changed.');
    Object.assign(marker, { schema: 3, selection: verifiedRelease.selection, runtime: { nodeMajor: Number(major), minimumNode: minimum } });
  }
  const header = verifiedRelease ? '# Generated experimental formula from a verified published stable release.\n# Tap publication and adoption remain separate approvals.' : '# Generated local-only experiment. No published-release claim.\n# Source revision is caller-supplied; archive checksum pins the actual bytes.';
  return `${header}\nrequire "json"\nrequire "shellwords"\n\nclass BallinExperiment < Formula\n  desc "Local Ballin package ownership experiment"\n  homepage "https://github.com/JBallin/ballin-scripts"\n  url ${rubyString(verifiedRelease ? verifiedRelease.archiveUrl : pathToFileURL(archive).href)}\n  version ${rubyString(verifiedRelease ? metadata.version : `${metadata.version}-dev.${sourceRevision.slice(0, 12)}`)}\n  sha256 ${rubyString(checksum)}\n  license "MIT"\n  depends_on :macos\n  depends_on "node@${major}"\n\n  def install\n    node = Formula["node@${major}"].opt_bin/"node"\n    system node, "-e", ${rubyString(`const a=process.versions.node.split('.').map(Number), b='${minimum}'.split('.').map(Number); if(a[0]!==${major} || a[0]<b[0] || (a[0]===b[0] && (a[1]<b[1] || (a[1]===b[1] && a[2]<b[2])))) process.exit(1);`)}\n    libexec.install "bin", "commands", "config", "completions", "package.json"\n    (libexec/"completion-node").write <<~EOS\n      #!/bin/sh\n      exec #{Shellwords.escape(node.to_s)} "$@"\n    EOS\n    (libexec/"completion-node").chmod 0755\n    completion_node = "_ballin_completion_node=#{Shellwords.escape((opt_libexec/"completion-node").to_s)}\\n"\n    completion_helper = "\\n_ballin_completion_helper=#{Shellwords.escape((opt_libexec/"commands/completion_members.ts").to_s)}\\n"\n    bash_completion = libexec/"completions/ballin.bash"\n    File.write(bash_completion, bash_completion.read + "\\n" + completion_node + completion_helper)\n    zsh_completion = libexec/"completions/_ballin"\n    zsh_source = zsh_completion.read\n    odie "Expected zsh compdef header" unless zsh_source.start_with?("#compdef ballin\\n")\n    File.write(zsh_completion, zsh_source + "\\n" + completion_node + completion_helper)\n    marker = JSON.parse(${rubyString(JSON.stringify(marker))})\n    marker["commandPath"] = (opt_bin/"ballin").to_s\n    marker["completionRoot"] = (opt_libexec/"completions").to_s\n    (libexec/".ballin-package.json").write(JSON.generate(marker) + "\\n")\n    (bin/"ballin").write <<~EOS\n      #!/bin/sh\n      exec #{Shellwords.escape(node.to_s)} #{Shellwords.escape((libexec/"bin/ballin").to_s)} "$@"\n    EOS\n    (bin/"ballin").chmod 0755\n  end\n\n  def caveats\n    "Experimental ${verifiedRelease ? 'stable-release' : 'development'} package. Run ballin setup --initial when ready; backups are optional. User state remains in ~/.ballin after removal."\n  end\n\n  test do\n    assert_match "ballin", shell_output("#{bin}/ballin help")\n  end\nend\n`;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    const names = { '--archive': 'archive', '--sha256': 'checksum', '--source-sha': 'sourceRevision', '--node-major': 'nodeMajor', '--formula': 'formula' };
    for (let i = 0; i < args.length; i += 2) {
      const key = names[args[i]];
      if (!key || !args[i + 1] || options[key]) throw Error('Use --archive ABSOLUTE_PATH --sha256 SHA256 --source-sha FULL_SHA [--node-major MAJOR] [--formula USER/TAP/ballin-experiment].');
      options[key] = args[i + 1];
    }
    process.stdout.write(generate(options));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { generate };
