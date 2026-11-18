const fs = require('fs');
const path = require('path');
const { stringify } = require('./store.ts');
const { PortableConfigError, readSetupConfigContext } = require('./portable.ts');
const { terminalPath, terminalError, terminalUrls } = require('../commands/terminalStyle.ts');
const { writeStdoutLine, runNodeScript, requireUninterrupted } = require('../commands/commandHelpers.ts');
type ConfigLeaf = string | number | boolean | null;
type ConfigObject = { [key: string]: ConfigValue };
type ConfigValue = ConfigLeaf | ConfigObject;

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const configPathFor = (repoDir: string): string => path.join(repoDir, 'ballin.config.json');

// Capture choices before configure() supplies defaults for this invocation.
const readOriginalSetupConfig = (configPath: string): Record<string, unknown> | null => {
  try {
    return readSetupConfigContext(configPath);
  } catch (error) {
    const message = error instanceof PortableConfigError
      ? (error as Error).message
      : 'Unable to inspect local configuration.';
    writeStdoutLine(`\n${terminalError(message)}`);
    writeStdoutLine('Repair the local configuration before retrying setup.');
    return null;
  }
};

const commandEnv = (cwd: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PWD: cwd,
});

const updateConfig = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir), deferBackupSelection = false): boolean => {
  const updateConfigPath = path.join(repoDir, 'config', 'updateConfig.ts');
  const childEnv = commandEnv(path.join(repoDir, 'config'));
  childEnv.BALLIN_TEST_CONFIG_PATH = configPath;
  childEnv.BALLIN_DEFER_BACKUP_SELECTION = deferBackupSelection ? '1' : '0';

  const updateResult = runNodeScript(updateConfigPath, {
    cwd: path.join(repoDir, 'config'),
    env: childEnv,
  });

  requireUninterrupted(updateResult);
  if (updateResult.stderr) {
    process.stderr.write(updateResult.stderr);
  }

  if (updateResult.status !== 0 || updateResult.error) {
    return false;
  }

  const updateOutput = updateResult.stdout.trimEnd();
  if (updateOutput) {
    writeStdoutLine(`\n🙌 ${updateOutput}`);
    writeStdoutLine(`\n${terminalUrls(`${docsUrl}#what-installation-changes`)}`);
  }

  return true;
};

const createDefaultConfig = (repoDir: string, configPath: string, deferBackupSelection = false): boolean => {
  const defaultConfigPath = path.join(repoDir, 'config', '.defaultConfig.json');
  try {
    const defaults = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
    if (deferBackupSelection) {
      delete defaults.backup.repository;
      delete defaults.backup.includeSensitive;
    }
    defaults._setup = { unreviewedNvm: true };
    fs.writeFileSync(configPath, stringify(defaults), { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  writeStdoutLine(`⚙️  Created config: ${terminalPath(configPath)}`);
  return true;
};

const configure = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir), deferBackupSelection = false): boolean => {
  if (!fs.existsSync(configPath)) return createDefaultConfig(repoDir, configPath, deferBackupSelection);
  return updateConfig(repoDir, docsUrl, configPath, deferBackupSelection);
};

const preferenceBoolean = (value: unknown, key: string): boolean => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Invalid \`${key}\`; expected true or false.`);
};

// One neutral writer for confirmed setup choices. Reread at the transaction
// boundary so unrelated local edits survive, including restored preferences.
const saveSetupPreference = (file: string, section: 'update' | 'analytics', key: string, enabled: boolean): unknown => {
  const current = readSetupConfigContext(file, false);
  const previous = current[section]?.[key];
  current[section] = { ...current[section], [key]: String(enabled) };
  if (section === 'update' && key === 'nvm') delete current._setup;
  require('./writeConfigFile.ts').writeConfigFile(file, stringify(current));
  return previous;
};
module.exports = { isConfigObject, configPathFor, readOriginalSetupConfig, createDefaultConfig, configure, saveSetupPreference, preferenceBoolean };
