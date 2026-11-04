const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const assetsDirectory = __dirname;
const repositoryRoot = path.resolve(assetsDirectory, '../..');
const printerPath = path.join(assetsDirectory, 'print-readme-update-example.ts');
const rendererPath = path.join(assetsDirectory, 'render-readme-update-example.swift');
const outputPath = path.join(assetsDirectory, 'readme-update-example.png');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let temporaryDirectory: string | undefined;

try {
  const printer = spawnSync(process.execPath, [printerPath], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (printer.error) throw new Error(`Unable to run the example printer: ${printer.error.message}`);
  if (printer.status !== 0) throw new Error(`The example printer exited with status ${printer.status ?? 'unknown'}.`);
  if (!printer.stdout?.length) throw new Error('The example printer produced no output.');

  temporaryDirectory = fs.mkdtempSync(path.join(assetsDirectory, '.readme-update-example-'));
  const temporaryPngPath = path.join(temporaryDirectory, 'readme-update-example.png');
  const renderer = spawnSync('swift', [
    '-module-cache-path',
    path.join(os.tmpdir(), 'ballin-update-example-swift-cache'),
    rendererPath,
    temporaryPngPath,
  ], {
    cwd: repositoryRoot,
    input: printer.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (renderer.error) throw new Error(`Unable to run the image renderer: ${renderer.error.message}`);
  if (renderer.status !== 0) throw new Error(`The image renderer exited with status ${renderer.status ?? 'unknown'}.`);

  const png = fs.readFileSync(temporaryPngPath);
  if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('The image renderer did not produce a PNG.');
  }

  fs.renameSync(temporaryPngPath, outputPath);
  process.stdout.write(`Wrote ${path.relative(repositoryRoot, outputPath)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`README example image generation failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
