const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const source = fs.realpathSync(process.env.PERF_SOURCE);
const evidence = process.env.PERF_EVIDENCE;
fs.mkdirSync(evidence, { recursive: true });
process.chdir(source);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const extensions = require(path.join(source, 'package.json')).mocha.extension;
const native = require(path.join(source, 'node_modules/mocha/lib/cli')).lookupFiles('test', extensions);
const lifecycle = 'test/repository_backup.test.ts';
const files = [...native.filter(f => f === lifecycle), ...native.filter(f => f !== lifecycle)];
if (files[0] !== lifecycle || new Set(files).size !== files.length) throw Error('Invalid manifest');
const readOptional = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const manifest = {
  source, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  lockSha256: hash('package-lock.json'), node: process.version, execPath: process.execPath,
  v8: process.versions.v8, platform: process.platform, arch: process.arch, uid: process.getuid(),
  mocha: require(path.join(source, 'node_modules/mocha/package.json')).version,
  c8: require(path.join(source, 'node_modules/c8/package.json')).version,
  cpus: os.availableParallelism(), cpu: os.cpus()[0].model, ram: os.totalmem(), files,
  cpuStatus: readOptional('/proc/self/status'), cpuQuota: readOptional('/sys/fs/cgroup/cpu.max'),
  effectiveCpuSet: readOptional('/sys/fs/cgroup/cpuset.cpus.effective'),
  runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion,
  workflowCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  sourceInventory: git('ls-files', '-z').split('\0').filter(Boolean).map(file => ({ file, sha256: hash(file) })),
};
fs.writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
if (manifest.commit !== '4cb3abbc59c7cb3ca980702377e0e1dadd2a1e24') throw Error('Unexpected source revision');
if (git('status', '--porcelain')) throw Error('Frozen source has local changes');
if (manifest.cpus < 4) throw Error('Comparison requires at least four available hosted CPUs');
