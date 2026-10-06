'use strict';

// Driver-owned observation: never load Mocha in npm, c8, compilers or CLI children.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const read = filename => fs.readFileSync(filename, 'utf8');
const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const cpuList = value => value.trim().split(',').flatMap(part => {
  const [first, last = first] = part.split('-').map(Number);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) throw Error('Invalid CPU list');
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});

function resources() {
  const status = read('/proc/self/status');
  const affinity = cpuList(status.match(/^Cpus_allowed_list:\s*(.+)$/m)[1]);
  const cgroup = read('/proc/self/cgroup');
  const cgroupPath = cgroup.match(/^0::(.+)$/m)?.[1];
  if (!cgroupPath || cgroupPath.split('/').includes('..')) throw Error('Expected resolvable cgroup v2 path');
  const mounts = read('/proc/self/mountinfo').split('\n').filter(line => line.includes(' - cgroup2 '));
  if (mounts.length !== 1) throw Error('Expected one visible cgroup v2 mount');
  const fields = mounts[0].split(' - ')[0].split(' ');
  const mountRoot = unescapeMount(fields[3]);
  const mountPoint = unescapeMount(fields[4]);
  const relative = cgroupPath === mountRoot ? ''
    : cgroupPath.startsWith(mountRoot.replace(/\/$/, '') + '/') ? cgroupPath.slice(mountRoot.length)
      : cgroupPath;
  let current = path.join(mountPoint, relative);
  if (current !== mountPoint && !current.startsWith(mountPoint + '/')) throw Error('Cgroup path escapes mount');
  if (!fs.statSync(current).isDirectory()) throw Error('Current cgroup path is not visible');
  const quotas = [];
  while (true) {
    const filename = path.join(current, 'cpu.max');
    try {
      const value = read(filename).trim();
      const [limit, period, ...extra] = value.split(/\s+/);
      if (extra.length || !/^\d+$/.test(period) || Number(period) <= 0
        || (limit !== 'max' && (!/^\d+$/.test(limit) || Number(limit) <= 0))) throw Error('Malformed cpu.max');
      quotas.push({ path: filename, value, cores: limit === 'max' ? null : Number(limit) / Number(period) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      quotas.push({ path: filename, missing: true });
    }
    if (current === mountPoint) break;
    current = path.dirname(current);
  }
  const finite = quotas.filter(item => item.cores !== null && item.cores !== undefined).map(item => item.cores);
  return {
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, executable: process.execPath,
    mocha: JSON.parse(read(path.join(process.env.BENCH_319_SOURCE, 'node_modules/mocha/package.json'))).version,
    c8: JSON.parse(read(path.join(process.env.BENCH_319_SOURCE, 'node_modules/c8/package.json'))).version,
    uid: process.getuid(), gid: process.getgid(), availableParallelism: os.availableParallelism(), affinity,
    cgroup: { path: cgroupPath, mountRoot, mountPoint, quotas, effectiveVisibleQuota: finite.length ? Math.min(...finite) : null },
  };
}

let isMochaEntry = false;
if (process.env.BENCH_319_EVENT_DIR && process.env.BENCH_319_SOURCE && process.argv[1]) {
  try {
    const entry = fs.realpathSync(process.argv[1]);
    const installedMocha = fs.realpathSync(path.join(process.env.BENCH_319_SOURCE, 'node_modules/mocha'));
    isMochaEntry = ['bin/mocha.js', 'bin/_mocha', 'lib/nodejs/worker.js']
      .some(filename => entry === path.join(installedMocha, filename));
  } catch {
    // node -e/-p may use argv[1] as data rather than a filename.
  }
}
if (isMochaEntry && process.env.BENCH_319_EVENT_DIR && process.env.BENCH_319_SOURCE) {
  const directory = process.env.BENCH_319_EVENT_DIR;
  const root = process.env.BENCH_319_SOURCE;
  const Mocha = require(path.join(root, 'node_modules/mocha/lib/mocha.js'));
  const original = Mocha.prototype.run;
  Mocha.prototype.run = function (...args) {
    const runner = Reflect.apply(original, this, args);
    const files = this.files.map(filename => ({
      path: path.relative(root, filename),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    })).sort((a, b) => (a.path > b.path) - (a.path < b.path));
    const event = {
      pid: process.pid, parentPid: process.ppid, isWorker: this.isWorker,
      workerId: process.env.MOCHA_WORKER_ID ?? null, runnerClass: runner.constructor.name,
      jobs: this.options.jobs ?? null, files, resources: resources(),
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, `${process.pid}.jsonl`), JSON.stringify(event) + '\n');
    return runner;
  };
}

module.exports = { resources, cpuList };
if (require.main === module && process.argv[2] === '--resources') console.log(JSON.stringify(resources()));
