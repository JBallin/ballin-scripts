// Deliberately small stand-in for the two macOS plutil operations the guarded
// Quickstart journey needs. It is never used by a production entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.BALLIN_QA_ROOT;
const typeQuery = args.length === 3 && args[0] === '-type';
const rawQuery = args.length === 6 && args[0] === '-extract' && args[2] === 'raw' && args[3] === '-o' && args[4] === '-';
if (!root || (!typeQuery && !rawQuery)) process.exit(97);
const file = path.resolve(args[args.length - 1]);
if (!file.startsWith(path.join(root, 'tmp') + path.sep) || !fs.lstatSync(file).isFile()
  || fs.realpathSync(file) !== file) process.exit(97);
try {
  let value = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of args[1].split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) process.exit(1);
    value = value[key];
  }
  const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number'
    ? Number.isInteger(value) ? 'integer' : 'float' : typeof value === 'string' ? 'string' : '';
  if (!type) process.exit(1);
  process.stdout.write((typeQuery ? type : type === 'float' ? value.toFixed(6) : String(value)) + '\n');
} catch { process.exit(1); }
