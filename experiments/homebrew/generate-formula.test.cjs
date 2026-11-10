const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { generate } = require('./generate-formula.cjs');
const { renderFormulaWrapper } = require('./formula-wrapper-fixture.cjs');
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
  assert.doesNotMatch(formula, /write_env_script|PATH:/);
  assert.doesNotMatch(formula, /depends_on "(?:git|gh|npm|nvm)"|npm (?:ci|install)|releaseId/);
  assert.match(generate({ ...options, formula: 'ballin-local/choice/ballin-experiment' }), /\"formula\":\"ballin-local\/choice\/ballin-experiment\"/);
  assert.throws(() => generate({ ...options, formula: 'invalid;command' }), /formula identity/);
  assert.match(generate({ ...options, nodeMajor: 24 }), /depends_on "node@24"/);
  assert.throws(() => generate({ ...options, nodeMajor: 22 }), /below/);
  assert.throws(() => generate({ ...options, nodeMajor: '26;evil' }), /below/);
});

test('generated executable uses package Node while preserving caller PATH, argv and exit status', t => {
  const options = fixture(t), formula = generate(options);
  const base = path.dirname(options.archive);
  const quoted = "space 'quote\" $dollar `tick` & \\backslash";
  const keg = path.join(base, 'Cellar', quoted, '1.0.0');
  const libexec = path.join(keg, 'libexec');
  const bin = path.join(keg, 'bin');
  const runtimeBin = path.join(base, 'package Node', quoted, 'bin');
  const callerBin = path.join(base, 'caller tools');
  const emptyBin = path.join(base, 'empty tools');
  const home = path.join(base, 'home'), tmp = path.join(base, 'tmp');
  for (const directory of [bin, path.join(libexec, 'bin'), runtimeBin, callerBin, emptyBin, home, tmp]) fs.mkdirSync(directory, { recursive: true });
  const node = path.join(runtimeBin, 'node');
  fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(path.join(runtimeBin, 'npm'), '#!/bin/sh\nprintf "package npm"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(callerBin, 'npm'), '#!/bin/sh\nprintf "caller npm"\n', { mode: 0o755 });
  const entry = path.join(libexec, 'bin/ballin');
  fs.writeFileSync(entry, `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
let npm;
try { npm = execFileSync('npm', ['ls', '--global', '--json'], { encoding: 'utf8' }); }
catch (error) { npm = error.code; }
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH, entry: __filename, node: process.execPath, npm }));
process.stderr.write('fixture stderr\\n');
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE);
`, { mode: 0o755 });
  const wrapper = renderFormulaWrapper({ formula, node, libexec, bin });
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755);
  assert.ok(fs.readFileSync(wrapper, 'utf8').startsWith('#!/bin/sh\n'));
  const argv = ['', 'two words', "quote'\"", '$HOME', '`printf bad`', '$(printf bad)', '*', 'line\nbreak', '\\backslash', '--flag=value', '日本語'];
  for (const ambientNode of ['absent', 'incompatible']) {
    if (ambientNode === 'incompatible') fs.writeFileSync(path.join(callerBin, 'node'), '#!/bin/sh\nprintf "v18.0.0\\n" >&2\nexit 91\n', { mode: 0o755 });
    const result = spawnSync(wrapper, argv, {
      cwd: home,
      env: { PATH: callerBin, HOME: home, TMPDIR: tmp, FIXTURE_EXIT_CODE: '23' },
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, ambientNode);
    assert.equal(result.status, 23, `${ambientNode}: ${result.stderr}`);
    assert.equal(result.stderr, 'fixture stderr\n');
    assert.deepEqual(JSON.parse(result.stdout), { argv, path: callerBin, entry: fs.realpathSync(entry), node: fs.realpathSync(process.execPath), npm: 'caller npm' });
  }
  const absentNpm = spawnSync(wrapper, [], {
    cwd: home,
    env: { PATH: emptyBin, HOME: home, TMPDIR: tmp, FIXTURE_EXIT_CODE: '0' },
    encoding: 'utf8',
  });
  assert.equal(absentNpm.status, 0, absentNpm.stderr);
  assert.equal(JSON.parse(absentNpm.stdout).npm, 'ENOENT');
  assert.equal(JSON.parse(absentNpm.stdout).path, emptyBin);
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
  const body = formula.slice(formula.indexOf('    (libexec/"completion-node").write '), formula.indexOf('    marker ='));
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
  assert.equal(execFileSync('/bin/bash', ['-c', nodeAssignment + '; printf "%s" "$_ballin_completion_node"'], { encoding: 'utf8' }), '/opt/experimental space/opt/ballin-experiment/libexec/completion-node');
});

for (const shell of ['/bin/bash', '/bin/zsh']) {
  test(`already-sourced ${shell} completion follows package and runtime after removal`, t => {
    const options = fixture(t), formula = generate(options);
    const base = path.dirname(options.archive);
    const quoted = "space 'quote\" $dollar `tick` & \\backslash";
    const oldKeg = path.join(base, quoted, 'old keg'), newKeg = path.join(base, quoted, 'new keg');
    const opt = path.join(base, quoted, 'stable opt');
    const home = path.join(base, 'home'), emptyBin = path.join(base, 'empty bin');
    for (const directory of [home, emptyBin]) fs.mkdirSync(directory);
    const runtimes = [];
    for (const [root, value] of [[oldKeg, 'old'], [newKeg, 'new']]) {
      fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(root, 'completions'));
      fs.writeFileSync(path.join(root, 'commands/completion_members.ts'), `process.stdout.write('${value}');`);
      const runtime = path.join(base, quoted, `${value} Node`);
      // Distinct executables model removal of the old major, not just a keg change.
      fs.writeFileSync(runtime, `#!/bin/sh\nprintf '${value}-runtime:'\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
      runtimes.push(runtime);
      const source = '_ballin_completion_node=node\n_ballin_completion_helper="old-physical-path"\nprobe_completion() { command "${_ballin_completion_node:-node}" "$_ballin_completion_helper"; }\n';
      fs.writeFileSync(path.join(root, 'completions/ballin.bash'), source);
      fs.writeFileSync(path.join(root, 'completions/_ballin'), '#compdef ballin\n' + source);
      const body = formula.slice(formula.indexOf('    (libexec/"completion-node").write '), formula.indexOf('    marker ='));
      execFileSync('/usr/bin/ruby', ['-rpathname', '-rshellwords', '-e', 'node = Pathname.new(ARGV[0]); libexec = Pathname.new(ARGV[1]); $opt = Pathname.new(ARGV[2]); def opt_libexec; $opt; end; ' + body, runtime, root, opt], {
        env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home },
      });
      assert.equal(fs.statSync(path.join(root, 'completion-node')).mode & 0o777, 0o755);
    }
    fs.symlinkSync(oldKeg, opt);
    const asset = shell.endsWith('zsh') ? '_ballin' : 'ballin.bash';
    const script = '. "$1/completions/$5"; probe_completion; /bin/rm "$1"; /bin/ln -s "$3" "$1"; /bin/rm -rf "$2"; /bin/rm "$4"; probe_completion';
    const result = spawnSync(shell, ['-f', '-c', script, 'completion-upgrade-fixture', opt, oldKeg, newKeg, runtimes[0], asset], {
      cwd: home, env: { PATH: emptyBin, HOME: home, TMPDIR: home, ZDOTDIR: home }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'old-runtime:oldnew-runtime:new');
    assert.equal(fs.existsSync(oldKeg), false);
    assert.equal(fs.existsSync(runtimes[0]), false);
  });
}
