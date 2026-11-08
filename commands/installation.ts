const fs = require('fs');
const path = require('path');
const os = require('os');

// Only a marker beside the installed code selects package ownership. Ambient
// environment variables must not turn an existing Git checkout into a package.
type PackageMetadata = { manager: 'homebrew'; schema: 1 | 2; formula?: string; version?: string; sourceRevision?: string; archiveSha256?: string;
  selection?: { kind: 'development' }; commandPath?: string; completionRoot?: string };
const readPackageMetadata = (repoDir = path.join(__dirname, '..')): PackageMetadata | undefined => {
  const file = path.join(repoDir, '.ballin-package.json');
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling marker is broken package metadata, not proof of Git ownership.
      try { fs.lstatSync(file); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      }
    }
    throw new Error('Unable to verify Ballin package ownership. Reinstall the package before retrying.');
  }
  let marker;
  try { marker = JSON.parse(contents); } catch {
    throw new Error('Invalid Ballin package ownership metadata. Reinstall the package before retrying.');
  }
  if (marker?.manager !== 'homebrew' || ![1, 2].includes(marker?.schema)) {
    throw new Error('Unsupported Ballin package ownership metadata. Reinstall the package before retrying.');
  }
  if (marker.schema === 2) {
    const safePath = (value: unknown): value is string => typeof value === 'string'
      && path.isAbsolute(value) && !/[\r\n\0]/u.test(value);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(marker.version)
      || !/^[0-9a-f]{40}$/u.test(marker.sourceRevision) || !/^[0-9a-f]{64}$/u.test(marker.archiveSha256)
      || typeof marker.formula !== 'string' || !/^[a-z0-9][a-z0-9+_.@-]*(?:\/[a-z0-9][a-z0-9+_.@-]*){0,2}$/u.test(marker.formula)
      || marker.selection?.kind !== 'development'
      || !safePath(marker.commandPath) || !safePath(marker.completionRoot)) {
      throw new Error('Invalid Ballin package provenance. Reinstall the package before retrying.');
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    if (metadata.version !== marker.version) throw new Error('Ballin package version disagrees with its provenance. Reinstall before retrying.');
  }
  return marker;
};
const isHomebrewInstallation = (repoDir = path.join(__dirname, '..')): boolean => Boolean(readPackageMetadata(repoDir));

// Resolve only files; never execute a candidate command to establish ownership.
const homebrewCommandOwner = (command: string): boolean => {
  let resolved: string;
  try { resolved = fs.realpathSync(command); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const target = path.resolve(path.dirname(command), fs.readlinkSync(command));
      if (/\/Cellar\/[^/]+\/[^/]+\/bin\/ballin$/u.test(target)) throw new Error('Package command target is unresolved. Repair it with Homebrew before retrying.');
    } catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError;
    }
    return false;
  }
  const directory = path.dirname(resolved);
  const prefix = path.dirname(directory);
  return Boolean(readPackageMetadata(prefix) || readPackageMetadata(path.join(prefix, 'libexec')));
};
const selectedPackageCommand = (repoDir: string, env: NodeJS.ProcessEnv = process.env): { status: 'pass' | 'warn' | 'fail'; summary: string } | undefined => {
  const metadata = readPackageMetadata(repoDir);
  if (!metadata) return undefined;
  if (!metadata.commandPath) return { status: 'warn', summary: 'Package command ownership cannot be verified: legacy package metadata.' };
  let selected: string | undefined;
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', 'ballin');
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); selected = candidate; break; } } catch { /* Not a usable executable. */ }
  }
  if (!selected) return { status: 'fail', summary: 'No executable ballin command is available on PATH.' };
  try {
    const expected = fs.realpathSync(metadata.commandPath);
    const sourceCommand = fs.realpathSync(path.join(repoDir, 'bin', 'ballin'));
    const wrapperRoot = path.join(path.dirname(path.dirname(expected)), 'libexec');
    if (expected !== sourceCommand && fs.realpathSync(wrapperRoot) !== fs.realpathSync(repoDir)) {
      return { status: 'warn', summary: 'The active package command belongs to another version. Run the active Ballin command before setup.' };
    }
    if (fs.realpathSync(selected) === expected) {
      return { status: 'pass', summary: 'PATH selects the Homebrew-owned Ballin command.' };
    }
  } catch { return { status: 'fail', summary: 'The package command cannot be resolved. Repair the Homebrew link before retrying.' }; }
  return { status: 'warn', summary: `Another Ballin command takes precedence on PATH: ${selected}. No links were changed.` };
};
const stateDirectory = (repoDir = path.join(__dirname, '..')): string => (
  isHomebrewInstallation(repoDir) ? path.join(os.homedir(), '.ballin') : repoDir
);
const configurationFile = (repoDir = path.join(__dirname, '..')): string => (
  path.join(stateDirectory(repoDir), 'ballin.config.json')
);
const prepareConfigurationDirectory = (file: string, repoDir = path.join(__dirname, '..')): void => {
  if (isHomebrewInstallation(repoDir) && file === configurationFile(repoDir)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
};
const packageFormula = (): string => readPackageMetadata()?.formula ?? 'ballin';
module.exports = { packageFormula, readPackageMetadata, homebrewCommandOwner, selectedPackageCommand, isHomebrewInstallation, stateDirectory, configurationFile, prepareConfigurationDirectory };
