const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const assetsDirectory = path.join(__dirname, '..', 'docs', 'assets');
const printerPath = path.join(assetsDirectory, 'print-readme-update-example.ts');
const generatorPath = path.join(assetsDirectory, 'generate-readme-update-example.ts');

const makeGeneratorFixture = (printerSource: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-update-example-'));
  const assets = path.join(root, 'docs', 'assets');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(bin);

  const fixtureGenerator = path.join(assets, 'generate-readme-update-example.ts');
  const fixturePrinter = path.join(assets, 'print-readme-update-example.ts');
  const fixtureRenderer = path.join(assets, 'render-readme-update-example.swift');
  const fixturePng = path.join(assets, 'readme-update-example.png');
  const swiftMarker = path.join(root, 'swift-was-run');
  const swiftShim = path.join(bin, 'swift');

  fs.copyFileSync(generatorPath, fixtureGenerator);
  fs.writeFileSync(fixturePrinter, printerSource);
  fs.writeFileSync(fixtureRenderer, 'renderer fixture');
  fs.writeFileSync(fixturePng, 'existing image');
  fs.writeFileSync(swiftShim, [
    '#!/bin/bash',
    'printf called > "$SWIFT_MARKER"',
    'cat >/dev/null',
    'printf "\\211PNG\\r\\n\\032\\npartial renderer output" > "$4"',
    'exit "$RENDERER_STATUS"',
    '',
  ].join('\n'));
  fs.chmodSync(swiftShim, 0o755);

  const run = (rendererMode = 0) => spawnSync(process.execPath, [fixtureGenerator], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH ?? ''].join(path.delimiter),
      RENDERER_STATUS: String(rendererMode),
      SWIFT_MARKER: swiftMarker,
    },
  });

  return { root, assets, fixturePng, swiftMarker, run };
};

describe('README update example image generation', () => {
  it('prints the fixed sample with the source-defined heading and status emphasis', () => {
    const result = spawnSync(process.execPath, [printerPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, '\x1b[1m$ ballin update\x1b[0m\n');
    assert.include(result.stdout, '\x1b[34m==>\x1b[1;39m Updating Homebrew...\x1b[0m');
    assert.include(result.stdout, '\x1b[1m✎ zshrc\x1b[0m');
    assert.include(result.stdout, '✔ ballin_config\n✔ bash_completions\n✔ Brewfile\n...\n');
    assert.notInclude(result.stdout, '\x1b[1m✔');
    assert.equal((result.stdout.match(/\x1b\[34m==>/g) ?? []).length, 11);
  });

  it('preserves the existing PNG when the printer fails after writing partial output', () => {
    const fixture = makeGeneratorFixture('process.stdout.write("partial sample"); process.exitCode = 17;');
    try {
      const result = fixture.run();
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'printer exited with status 17');
      assert.equal(fs.readFileSync(fixture.fixturePng, 'utf8'), 'existing image');
      assert.isFalse(fs.existsSync(fixture.swiftMarker));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves the existing PNG when the printer succeeds with empty output', () => {
    const fixture = makeGeneratorFixture('');
    try {
      const result = fixture.run();
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'produced no output');
      assert.equal(fs.readFileSync(fixture.fixturePng, 'utf8'), 'existing image');
      assert.isFalse(fs.existsSync(fixture.swiftMarker));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves the existing PNG when the renderer fails after writing a partial file', () => {
    const fixture = makeGeneratorFixture('process.stdout.write("sample");');
    try {
      const result = fixture.run(23);
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'renderer exited with status 23');
      assert.equal(fs.readFileSync(fixture.fixturePng, 'utf8'), 'existing image');
      assert.isTrue(fs.existsSync(fixture.swiftMarker));
      assert.deepEqual(fs.readdirSync(fixture.assets).sort(), [
        'generate-readme-update-example.ts',
        'print-readme-update-example.ts',
        'readme-update-example.png',
        'render-readme-update-example.swift',
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('replaces the PNG only after the renderer succeeds', () => {
    const fixture = makeGeneratorFixture('process.stdout.write("sample");');
    try {
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Wrote docs/assets/readme-update-example.png');
      assert.isTrue(fs.readFileSync(fixture.fixturePng).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
