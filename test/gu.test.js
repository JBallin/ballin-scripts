const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guPath = path.join(__dirname, '..', 'bin', 'gu');

describe('gu', () => {
  let homeDir;
  let binDir;
  let cacheDir;
  let gistDir;
  let readLogPath;
  let uploadLogPath;

  const fileName = 'zshrc.sh';

  const installCommand = (command) => {
    const commandPath = process.env.PATH
      .split(path.delimiter)
      .map((directory) => path.join(directory, command))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${command} is required to run the gu test harness`);
    fs.symlinkSync(commandPath, path.join(binDir, command));
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-gu-'));
    binDir = path.join(homeDir, 'bin');
    cacheDir = path.join(homeDir, '.ballin-scripts', '.gu-cache');
    gistDir = path.join(homeDir, 'gist');
    readLogPath = path.join(homeDir, 'gist-reads.log');
    uploadLogPath = path.join(homeDir, 'gist-uploads.log');

    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(homeDir, '.ballin-scripts'));
    fs.mkdirSync(path.join(homeDir, 'Library', 'Application Support'), { recursive: true });
    fs.mkdirSync(gistDir);
    [
      'bash',
      'cat',
      'cmp',
      'cp',
      'mkdir',
      'mktemp',
      'rm',
      'tail',
    ].forEach(installCommand);
    fs.writeFileSync(
      path.join(binDir, 'ballin_config'),
      `#!/usr/bin/env bash
if [ "$1" != 'get' ]; then
  printf '%s\\n' 'Unexpected ballin_config action' >&2
  exit 2
elif [ "$2" = 'gu.id' ]; then
  printf '%s\\n' 'test-gist-id'
elif [ "$2" = 'gu.url' ]; then
  printf '%s\\n' 'https://example.test/gists'
else
  printf '%s\\n' 'Unexpected ballin_config call' >&2
  exit 2
fi
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, 'gist'),
      `#!/usr/bin/env bash
if [ "$2" != 'test-gist-id' ]; then
  printf '%s\\n' 'Unexpected Gist ID' >&2
  exit 2
fi
if [ "$1" = '-r' ]; then
  if [ "$#" -eq 2 ]; then
    exit 0
  elif [ "$#" -ne 3 ]; then
    printf '%s\\n' 'Unexpected gist read arguments' >&2
    exit 2
  fi
  printf '%s\\n' "$3" >> "$GIST_TEST_READ_LOG"
  gist_file="$GIST_TEST_DIR/$3"
  if [ -f "$gist_file" ]; then
    cat "$gist_file"
  else
    exit 1
  fi
elif [ "$1" = '-u' ]; then
  if [ "$#" -ne 3 ]; then
    printf '%s\\n' 'Unexpected gist upload arguments' >&2
    exit 2
  fi
  cache_file="$3"
  file_name="\${cache_file##*/}"
  cp "$cache_file" "$GIST_TEST_DIR/$file_name"
  printf '%s\\n' "$file_name" >> "$GIST_TEST_UPLOAD_LOG"
else
  printf '%s\\n' 'Unexpected gist call' >&2
  exit 2
fi
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const runGu = () => spawnSync(guPath, [], {
    encoding: 'utf8',
    env: {
      HOME: homeDir,
      PATH: binDir,
      BALLIN_GU_BASH_COMPLETION_DIR: path.join(homeDir, 'bash-completion.d'),
      GIST_TEST_DIR: gistDir,
      GIST_TEST_READ_LOG: readLogPath,
      GIST_TEST_UPLOAD_LOG: uploadLogPath,
    },
  });

  const snapshotPath = () => path.join(homeDir, '.zshrc');
  const cachePath = () => path.join(cacheDir, fileName);
  const gistPath = () => path.join(gistDir, fileName);
  const writeSnapshot = (content) => fs.writeFileSync(snapshotPath(), content);
  const seedCache = (content) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(), content);
  };
  const seedGist = (content) => fs.writeFileSync(gistPath(), content);
  const assertSucceeded = (result) => {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  };
  const reads = () => (
    fs.existsSync(readLogPath)
      ? fs.readFileSync(readLogPath, 'utf8').trim().split('\n')
      : []
  );
  const uploads = () => (
    fs.existsSync(uploadLogPath)
      ? fs.readFileSync(uploadLogPath, 'utf8').trim().split('\n')
      : []
  );

  it('creates and uploads the first snapshot when cache and Gist are missing', () => {
    writeSnapshot('alias hello="world"\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'alias hello="world"\n');
    assert.equal(fs.readFileSync(gistPath(), 'utf8'), 'alias hello="world"\n');
    assert.deepEqual(reads(), [fileName]);
    assert.deepEqual(uploads(), [fileName]);
  });

  it('uses the current new-file icon for a first empty snapshot', () => {
    writeSnapshot('');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(gistPath(), 'utf8'), 'empty\n');
    assert.deepEqual(reads(), [fileName]);
    assert.deepEqual(uploads(), [fileName]);
  });

  it('hydrates a missing cache from unchanged Gist content', () => {
    writeSnapshot('export EDITOR=vim\n');
    seedGist('export EDITOR=vim\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'export EDITOR=vim\n');
    assert.deepEqual(reads(), [fileName]);
    assert.deepEqual(uploads(), []);
  });

  it('compares against hydrated Gist content before uploading a change', () => {
    writeSnapshot('new value\n');
    seedGist('old value\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'new value\n');
    assert.equal(fs.readFileSync(gistPath(), 'utf8'), 'new value\n');
    assert.deepEqual(reads(), [fileName]);
    assert.deepEqual(uploads(), [fileName]);
  });

  it('reports unchanged non-empty output without uploading it', () => {
    writeSnapshot('set -o vi\n');
    seedCache('set -o vi\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.deepEqual(uploads(), []);
  });

  it('reports and uploads changed non-empty output', () => {
    writeSnapshot('export COLOR=blue\n');
    seedCache('export COLOR=red\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(uploads(), [fileName]);
  });

  it('reports and uploads non-empty output becoming empty', () => {
    writeSnapshot('');
    seedCache('old content\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✖︎ zshrc\n');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'empty\n');
    assert.deepEqual(uploads(), [fileName]);
  });

  it('hides unchanged empty output and does not upload it', () => {
    writeSnapshot('');
    seedCache('empty\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(uploads(), []);
  });

  it('preserves the current changed icon when empty becomes non-empty', () => {
    writeSnapshot('restored\n');
    seedCache('empty\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.deepEqual(uploads(), [fileName]);
  });

  it('preserves multiple trailing blank lines', () => {
    writeSnapshot('line\n\n\n');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'line\n\n\n');
    assert.equal(fs.readFileSync(gistPath(), 'utf8'), 'line\n\n\n');
  });

  it('normalizes output missing its final newline', () => {
    writeSnapshot('line');

    const result = runGu();

    assertSucceeded(result);
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), 'line\n');
    assert.equal(fs.readFileSync(gistPath(), 'utf8'), 'line\n');
  });

  it('uploads a normalized snapshot only once when a later run is unchanged', () => {
    writeSnapshot('stable without newline');

    const firstResult = runGu();
    const secondResult = runGu();

    assertSucceeded(firstResult);
    assertSucceeded(secondResult);
    assert.equal(secondResult.stdout, '✔ zshrc\n');
    assert.deepEqual(uploads(), [fileName]);
  });
});
