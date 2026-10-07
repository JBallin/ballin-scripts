'use strict';
// Proposed fixture probe; not executed during the read-only assessment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const expectedCpus = JSON.parse(process.env.BENCH_319_EXPECTED_CPUS);
assert.equal(expectedCpus.length, 4);
assert.equal(new Set(expectedCpus).size, 4);
assert.ok(expectedCpus.every(cpu => Number.isInteger(cpu) && cpu >= 0));
const affinityText = fs.readFileSync('/proc/self/status', 'utf8')
  .match(/^Cpus_allowed_list:\s*(.+)$/m)[1];
const affinity = affinityText.trim().split(',').flatMap(part => {
  const [first, last = first] = part.split('-').map(Number);
  assert.ok(Number.isInteger(first) && Number.isInteger(last) && first >= 0 && last >= first);
  return Array.from({length: last - first + 1}, (_, index) => first + index);
});
assert.deepEqual(affinity, [...expectedCpus].sort((a, b) => a - b));
const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
assert.equal(cgroup, '0::/');
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
  .filter(line => line.includes(' - cgroup2 '));
assert.equal(mounts.length, 1);
const mountFields = mounts[0].split(' - ')[0].split(' ');
assert.equal(mountFields[3], '/');
assert.equal(mountFields[4], '/sys/fs/cgroup');
const quotaPath = '/sys/fs/cgroup/cpu.max';
const quota = fs.readFileSync(quotaPath, 'utf8').trim();
assert.equal(quota, '200000 100000');
assert.equal(process.getuid(), 1001);
assert.equal(process.getgid(), 1001);
assert.equal(os.availableParallelism(), 2);
assert.equal(process.version, process.env.DIAGNOSTIC_319_EXPECTED_NODE);
assert.equal(process.versions.v8, {
  'v24.15.0': '13.6.233.17-node.48',
  'v24.21.0': '13.6.233.17-node.53',
}[process.env.DIAGNOSTIC_319_EXPECTED_NODE]);
const subject = process.argv[2];
assert.ok(subject === './backup_cache.ts' || subject === './backup_cache.cjs');
const { repositoryCacheDirectory } = require(path.resolve(subject));
const values = [
  repositoryCacheDirectory('/fixture-root', {
    ownerId: 'fixture-owner', id: 'fixture-repo', branch: 'fixture-branch',
  }),
  repositoryCacheDirectory('/fixture-root', {
    ownerId: 'fixture-owner', id: 'fixture-repo-2', branch: 'fixture-branch',
  }),
];
assert.deepEqual(values, [
  '/fixture-root/fb648ab23d258e205cd1b4689abf09244ccfdfb19f6ce9cb214144f2007a8a07',
  '/fixture-root/ecc1c8afb93013c7fd73ea55518c051d7e06b9f96c411d74edb92a77a1259861',
]);
console.log(JSON.stringify({subject, values, node: process.version,
  v8: process.versions.v8, executable: process.execPath,
  uid: process.getuid(), gid: process.getgid(),
  availableParallelism: os.availableParallelism(),
  affinity, affinityText, cgroup, cgroupMountRoot: mountFields[3],
  cgroupMountPoint: mountFields[4], quotaPath, quota}));
