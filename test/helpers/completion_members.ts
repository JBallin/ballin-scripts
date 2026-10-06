const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path');
const { repositoryCacheDirectory } = require('../../commands/backup_cache.ts');

const bundle = 'codex_skills.bundle.json';
const destination = { id: 'repository-id', ownerId: 'owner-id', name: 'backup', branch: 'main' };
const archive = (names = ['skill with spaces/SKILL.md', "quotes'and\"marks/file.md", 'other/readme.md']) => JSON.stringify({
  format: 'ballin-directory', version: 2,
  entries: names.map((name) => ({ path: name, executable: false, encoding: 'utf8', content: ['text\n'] })),
});
const operationGuard = [
  "const fs = require('node:fs');",
  "const write = fs.writeFileSync;",
  "const forbid = () => { write(process.env.HOME + '/forbidden', 'forbidden'); throw new Error('Forbidden completion operation'); };",
  "for (const name of ['chmodSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync', 'appendFileSync', 'truncateSync']) fs[name] = forbid;",
  "const open = fs.openSync;",
  "fs.openSync = (file, flags, ...rest) => { if (typeof flags !== 'number' || (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))) forbid(); return open(file, flags, ...rest); };",
  "for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) require('node:child_process')[name] = forbid;",
  "for (const module of ['node:http', 'node:https']) { require(module).get = forbid; require(module).request = forbid; }",
  "require('node:net').connect = forbid; require('node:net').Socket.prototype.connect = forbid; global.fetch = forbid;",
].join('\n');
const prepareMemberFixture = (fixture: string): { config: string; cache: string; directory: string; file: string } => {
  const config = path.join(fixture, 'missing-config.json');
  const cache = path.join(fixture, '.backup-cache');
  const directory = repositoryCacheDirectory(cache, destination);
  const file = path.join(directory, bundle);
  fs.writeFileSync(config, JSON.stringify({ backup: { repository: destination } }));
  fs.mkdirSync(cache, { mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(file, archive(), { mode: 0o600 });
  fs.symlinkSync(process.execPath, path.join(fixture, 'node'));
  fs.writeFileSync(path.join(fixture, 'completion-guard.cjs'), operationGuard);
  return { config, cache, directory, file };
};

// Metadata and bytes both matter: completion may not repair or rewrite anything.
const fixtureState = (root: string): unknown => {
  const visit = (name: string): unknown => {
    const stat = fs.lstatSync(name);
    return { mode: stat.mode, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
      content: stat.isDirectory() ? fs.readdirSync(name).map((child) => [child, visit(path.join(name, child))])
        : stat.isSymbolicLink() ? fs.readlinkSync(name) : stat.isFile() ? fs.readFileSync(name).toString('base64') : null };
  };
  return visit(root);
};

module.exports = { prepareMemberFixture, fixtureState, archive, bundle, destination };
