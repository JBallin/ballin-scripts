const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const source = fs.realpathSync(process.env.PERF_SOURCE);
const evidence = process.env.PERF_EVIDENCE;
const variant = process.argv[2];
if (!['control', 'candidate'].includes(variant)) throw Error('Unknown variant');
fs.mkdirSync(evidence, { recursive: true });
process.chdir(source);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const native = require(path.join(source, 'node_modules/mocha/lib/cli')).lookupFiles('test', require(path.join(source, 'package.json')).mocha.extension);
const lifecycle = 'test/repository_backup.test.ts';
const files = [...native.filter(f => f === lifecycle), ...native.filter(f => f !== lifecycle)];
if (files[0] !== lifecycle || new Set(files).size !== files.length) throw Error('Invalid manifest');
const readOptional = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const inventory = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort().map(file => ({file, sha256:hash(file)}));
const manifest = {
  variant, candidateApplicationCommit:'824112c7b87e4376d496be61be19c987145eafa2', source, commit:git('rev-parse','HEAD'), tree:git('rev-parse','HEAD^{tree}'),
  lockSha256:hash('package-lock.json'), node:process.version, execPath:process.execPath,
  v8:process.versions.v8, platform:process.platform, arch:process.arch, uid:process.getuid(),
  mocha:require(path.join(source,'node_modules/mocha/package.json')).version,
  c8:require(path.join(source,'node_modules/c8/package.json')).version,
  cpus:os.availableParallelism(), cpu:os.cpus()[0].model, ram:os.totalmem(), files,
  cpuStatus:readOptional('/proc/self/status'), cpuQuota:readOptional('/sys/fs/cgroup/cpu.max'),
  effectiveCpuSet:readOptional('/sys/fs/cgroup/cpuset.cpus.effective'),
  runnerImage:process.env.ImageOS, runnerImageVersion:process.env.ImageVersion,
  workflowCommit:process.env.GITHUB_SHA, runId:process.env.GITHUB_RUN_ID,
  sourceInventory:inventory, gitStatus:git('status','--porcelain'),
};
if (manifest.commit !== '4cb3abbc59c7cb3ca980702377e0e1dadd2a1e24') throw Error('Unexpected frozen baseline');
if (manifest.cpus < 4) throw Error('Expected four available hosted CPUs');
if (variant === 'control' && manifest.gitStatus) throw Error('Baseline is dirty');
if (variant === 'candidate') {
  const control = JSON.parse(fs.readFileSync(path.join(evidence,'manifest-control.json')));
  const expected = ['docs/testing.md','test/helpers/repository-runtime.js','test/helpers/repository.ts','tsconfig.json'].sort();
  const old = new Map(control.sourceInventory.map(r=>[r.file,r.sha256]));
  const changed = inventory.filter(r=>old.get(r.file)!==r.sha256).map(r=>r.file).sort();
  if (JSON.stringify(changed)!==JSON.stringify(expected) || old.size+1!==inventory.length) throw Error('Unexpected candidate delta');
  for (const key of ['files','lockSha256','node','v8','execPath','mocha','c8','cpus','cpu','ram','effectiveCpuSet']) {
    if (JSON.stringify(manifest[key])!==JSON.stringify(control[key])) throw Error('Unmatched control: '+key);
  }
  manifest.changedFiles=changed;
}
fs.writeFileSync(path.join(evidence,`manifest-${variant}.json`),JSON.stringify(manifest,null,2));
process.stdout.write(JSON.stringify(manifest,null,2)+'\n');
