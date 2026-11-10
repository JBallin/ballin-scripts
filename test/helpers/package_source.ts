const fs = require('fs');
const path = require('path');

// Run the original modules with a fixture-owned package receipt. Only this one
// read is redirected in child processes; source files and host state stay intact.
// Copied-keg integration tests remain separate coverage of physical packaging.
const createPackageSourceFixture = (root: string, repoDir: string) => {
  const markerPath = path.join(root, 'package-receipt.json');
  const preloadPath = path.join(root, 'package-source-preload.cjs');
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => readFileSync.call(fs,
  file === ${JSON.stringify(path.join(repoDir, '.ballin-package.json'))}
    ? ${JSON.stringify(markerPath)} : file, ...args);
`);
  return { markerPath, env: { NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}` } };
};

module.exports = { createPackageSourceFixture };
