const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { generate } = require('./generate-formula.cjs');
function fixture(t, change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-formula-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source');
  for (const name of ['bin', 'commands', 'config', 'completions']) fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const file of ['bin/ballin', 'commands/ballin.ts', 'commands/installation.ts', 'config/.defaultConfig.json', 'completions/_ballin', 'completions/ballin.bash']) fs.writeFileSync(path.join(root, file), 'fixture\n');
  const metadata = { name: 'ballin-scripts', version: '1.0.0', engines: { node: '>=24.12' }, ballin: { installerProtocol: 2 } };
  fs.writeFileSync(path.join(root, '.nvmrc'), '26\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata));
  change(root, metadata);
  const archive = path.join(dir, "source's archive.tar.gz");
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', dir, 'source']);
  return { archive, checksum: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), sourceRevision: 'a'.repeat(40) };
}
test('deterministic local formula pins bytes, development provenance and managed runtime', t => {
  const options = fixture(t), formula = generate(options);
  assert.equal(generate(options), formula);
  assert.match(execFileSync('/usr/bin/ruby', ['-c'], { input: formula, encoding: 'utf8' }), /Syntax OK/);
  assert.match(formula, /file:\/\//);
  assert.ok(formula.includes("source\\'s%20archive"));
  assert.match(formula, /depends_on "node@26"/);
  assert.match(formula, /depends_on :macos/);
  assert.match(formula, /ballin setup --initial/);
  assert.match(formula, /require "shellwords"/);
  assert.match(formula, /Shellwords.escape\(node.to_s\)/);
  assert.match(formula, /File.write\(bash_completion, bash_completion.read \+ "\\n" \+ completion_node \+ completion_helper\)/);
  assert.match(formula, /File.write\(zsh_completion, zsh_source \+ "\\n" \+ completion_node \+ completion_helper\)/);
  assert.match(formula, /"schema":2/);
  assert.match(formula, /"formula":"ballin-experiment"/);
  assert.ok(formula.includes(`"archiveSha256":"${options.checksum}"`));
  assert.match(formula, /"selection":\{"kind":"development"\}/);
  assert.match(formula, /opt_bin\/"ballin"/);
  assert.match(formula, /opt_libexec\/"completions"/);
  assert.match(formula, /#\{node.dirname\}:\$PATH/);
  assert.doesNotMatch(formula, /depends_on "(?:git|gh|npm|nvm)"|npm (?:ci|install)|releaseId/);
  assert.match(generate({ ...options, formula: 'ballin-local/choice/ballin-experiment' }), /\"formula\":\"ballin-local\/choice\/ballin-experiment\"/);
  assert.throws(() => generate({ ...options, formula: 'invalid;command' }), /formula identity/);
  assert.match(generate({ ...options, nodeMajor: 24 }), /depends_on "node@24"/);
  assert.throws(() => generate({ ...options, nodeMajor: 22 }), /below/);
  assert.throws(() => generate({ ...options, nodeMajor: '26;evil' }), /below/);
});
test('rejects checksum mismatch and invalid provenance arguments', t => {
  const options = fixture(t);
  assert.throws(() => generate({ ...options, checksum: '0'.repeat(64) }), /mismatch/);
  assert.throws(() => generate({ ...options, sourceRevision: 'main' }), /commit SHA/);
  assert.throws(() => generate({ ...options, archive: 'relative.tar.gz' }), /absolute/);
});
test('rejects missing runtime files, preexisting marker and archive links', t => {
  for (const file of ['commands/installation.ts', 'completions/_ballin', 'completions/ballin.bash']) {
    assert.throws(() => generate(fixture(t, root => fs.unlinkSync(path.join(root, file)))), /Missing/);
  }
  assert.throws(() => generate(fixture(t, root => fs.writeFileSync(path.join(root, '.ballin-package.json'), '{}'))), /ownership marker/);
  assert.throws(() => generate(fixture(t, root => fs.symlinkSync('/tmp', path.join(root, 'linked')))), /regular files/);
});
test('rejects incompatible metadata instead of adding installation behavior', t => {
  for (const change of [m => { m.dependencies = { external: '*' }; }, m => { m.engines.node = '^24'; }, m => { m.version = 'next'; }, m => { m.ballin.installerProtocol = 1; }]) {
    assert.throws(() => generate(fixture(t, (root, metadata) => {
      change(metadata); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata));
    })), /metadata|dependencies|runtime/);
  }
});

test('installed completion assignments preserve quoting and the zsh header', t => {
  const options = fixture(t), formula = generate(options);
  const root = path.join(path.dirname(options.archive), 'source');
  fs.writeFileSync(path.join(root, 'completions/_ballin'), '#compdef ballin\n# zsh body\n');
  const runtime = "/tmp/Node space & quote' and \\backslash/bin/node";
  const body = formula.slice(formula.indexOf('    completion_node ='), formula.indexOf('    marker ='));
  execFileSync('/usr/bin/ruby', ['-rpathname', '-rshellwords', '-e', 'node = Pathname.new(ARGV[0]); libexec = Pathname.new(ARGV[1]); def opt_libexec; Pathname.new(\"/opt/experimental space/opt/ballin-experiment/libexec\"); end; ' + body, runtime, root]);
  const bash = fs.readFileSync(path.join(root, 'completions/ballin.bash'), 'utf8').split('\n');
  const zsh = fs.readFileSync(path.join(root, 'completions/_ballin'), 'utf8').split('\n');
  assert.equal(zsh[0], '#compdef ballin');
  assert.equal(zsh[1], '# zsh body');
  const nodeAssignment = bash.find(line => line.startsWith('_ballin_completion_node='));
  assert.equal(zsh.find(line => line.startsWith('_ballin_completion_node=')), nodeAssignment);
  assert.ok(bash.indexOf(nodeAssignment) > bash.indexOf('fixture'));
  assert.ok(zsh.indexOf(nodeAssignment) > zsh.indexOf('# zsh body'));
  const helperAssignment = bash.at(-2);
  assert.equal(zsh.at(-2), helperAssignment);
  assert.match(helperAssignment, /^_ballin_completion_helper=/);
  assert.equal(execFileSync('/bin/bash', ['-c', helperAssignment + '; printf "%s" "$_ballin_completion_helper"'], { encoding: 'utf8' }), '/opt/experimental space/opt/ballin-experiment/libexec/commands/completion_members.ts');
  assert.equal(execFileSync('/bin/bash', ['-c', nodeAssignment + '; printf "%s" "$_ballin_completion_node"'], { encoding: 'utf8' }), runtime);
});

test('an already-sourced completion follows opt after old keg removal', t => {
  const options = fixture(t), formula = generate(options);
  const base = path.dirname(options.archive), oldKeg = path.join(base, 'old keg'), newKeg = path.join(base, 'new keg'), opt = path.join(base, 'stable opt');
  for (const [root, value] of [[oldKeg, 'old'], [newKeg, 'new']]) {
    fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, 'commands/completion_members.ts'), `process.stdout.write('${value}');`);
  }
  fs.mkdirSync(path.join(oldKeg, 'completions'));
  const source = '_ballin_completion_node=node\n_ballin_completion_helper="old-physical-path"\nprobe_completion() { command "${_ballin_completion_node:-node}" "$_ballin_completion_helper"; }\n';
  fs.writeFileSync(path.join(oldKeg, 'completions/ballin.bash'), source);
  fs.writeFileSync(path.join(oldKeg, 'completions/_ballin'), '#compdef ballin\n' + source);
  fs.symlinkSync(oldKeg, opt);
  const body = formula.slice(formula.indexOf('    completion_node ='), formula.indexOf('    marker ='));
  execFileSync('/usr/bin/ruby', ['-rpathname', '-rshellwords', '-e', 'node = Pathname.new(ARGV[0]); libexec = Pathname.new(ARGV[1]); $opt = Pathname.new(ARGV[2]); def opt_libexec; $opt; end; ' + body, process.execPath, oldKeg, opt]);
  const shell = '. "$1/completions/ballin.bash"; probe_completion; /bin/rm "$1"; /bin/ln -s "$3" "$1"; /bin/rm -rf "$2"; probe_completion';
  assert.equal(execFileSync('/bin/bash', ['-c', shell, 'completion-upgrade-fixture', opt, oldKeg, newKeg], { encoding: 'utf8' }), 'oldnew');
  assert.equal(fs.existsSync(oldKeg), false);
});
