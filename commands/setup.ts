const fs = require('fs');
const path = require('path');
const { terminalCommand, terminalHeading, terminalComplete, terminalProse, terminalError } = require('./terminalStyle.ts');
const { savedPreferenceLine } = require('./preference_confirmation.ts');
const { configPath } = require('../config/index.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { createDefaultConfig, saveSetupPreference, preferenceBoolean } = require('../config/setup.ts');
const { configuredBackupDestination } = require('./backup_config.ts');
const { inspectNvm } = require('./nvm.ts');
const { readYesNo, promptInputState, rethrowInterruption, writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');

const setupHelp = `Usage: ballin setup

Review update and analytics preferences, using saved choices as defaults.
NVM updates are offered when NVM follows latest LTS or updates are already enabled. Automatic backup is offered when configured or already enabled.

Use \`ballin backup setup\` for backup destinations and sensitive sources. Use \`ballin config get/set/reset\` for direct configuration.

This review does not run updates, backups, or runtime installation.

🔗 Preferences:
https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md
`;

type SetupOutcome = 'completed' | 'cancelled' | 'failed';
const backupHint = (): void => writeStdoutLine(terminalProse(`Run ${terminalCommand('ballin backup setup')} to configure or review your GitHub backup.`));
const questions = [
  ['npm', 'Update global npm packages?'],
  ['selfUpdate', 'Keep Ballin up to date?'],
  ['cleanup', 'Clean up outdated Homebrew packages?'],
  ['softwareupdate', 'Install available macOS updates?'],
  ['nvm', 'Keep NVM-managed Node on latest LTS?'],
  ['backup', 'Back up to GitHub during updates?'],
] as const;

const reviewGeneralPreferences = (file: string, options: { installation?: boolean } = {}): SetupOutcome => {
  let reviewing = false;
  try {
    try { fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const repoDir = process.env.BALLIN_TEST_REPO_DIR || path.join(__dirname, '..');
      if (!createDefaultConfig(repoDir, file)) throw new Error('Unable to create local config.');
    }
    const config = readSetupConfigContext(file);
    // lstat distinguishes a missing file from an unreadable dangling link.
    if (fs.lstatSync(file).isSymbolicLink()) fs.statSync(file);
    const defaults = require('../config/.defaultConfig.json');
    questions.forEach(([key]) => preferenceBoolean(config.update?.[key] === undefined ? defaults.update[key] : config.update[key], `update.${key}`));
    preferenceBoolean(config.analytics?.enabled === undefined ? defaults.analytics.enabled : config.analytics.enabled, 'analytics.enabled');
    const destination = configuredBackupDestination(config);
    if (destination.kind === 'invalid') throw new Error('Invalid backup destination configuration.');
    const nvm = inspectNvm();
    reviewing = true;
    writeStdoutLine(terminalProse('Review your update and analytics preferences. Confirmed choices are saved; this does not run updates.'));
    writeStdoutLine(terminalProse('🔗 Optional capabilities:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md'));
    writeStdoutLine(`\n${terminalHeading('Update preferences')}`);
    const cancel = (): SetupOutcome => {
      writeStdoutLine('\nReview cancelled. Earlier confirmed choices remain saved.');
      backupHint();
      return 'cancelled';
    };
    const save = (section: 'update' | 'analytics', key: string, enabled: boolean): void => {
      const previous = saveSetupPreference(file, section, key, enabled);
      writeStdoutLine(terminalProse(savedPreferenceLine(`${section}.${key}`, enabled, previous)));
    };
    for (const [key, question] of questions) {
      const current = readSetupConfigContext(file, false);
      const saved = preferenceBoolean(current.update?.[key] === undefined ? defaults.update[key] : current.update[key], `update.${key}`);
      if (key === 'nvm' && !saved && !(nvm.loadable && nvm.followsLts)) {
        writeStdoutLine(terminalProse('ℹ️  NVM can maintain latest LTS Node when its default follows latest LTS.'));
        continue;
      }
      if (key === 'backup' && configuredBackupDestination(current).kind !== 'repository' && !saved) continue;
      const recommended = key === 'nvm' && current._setup?.unreviewedNvm === true ? true : saved;
      const enabled = readYesNo(`${question} ${recommended ? '[Y/n]' : '[y/N]'} `, recommended);
      if (enabled === null) return cancel();
      save('update', key, enabled);
    }
    const current = readSetupConfigContext(file, false);
    const analytics = preferenceBoolean(current.analytics?.enabled === undefined ? defaults.analytics.enabled : current.analytics.enabled, 'analytics.enabled');
    let cancelled = false;
    const { configureAnalyticsPreference } = require('./analytics.ts');
    if (!configureAnalyticsPreference({ configPath: file, defaultEnabled: analytics, detailsLink: false, reportFailure: false,
      onCancelled: () => { cancelled = true; } })) throw new Error('Unable to save the analytics preference; the existing local setting is unchanged.');
    if (cancelled) return cancel();
    if (!options.installation) writeStdoutLine(`\n${terminalComplete('😎 Setup complete.')}`);
    backupHint();
    return 'completed';
  } catch (error) {
    rethrowInterruption(error);
    writeStderrLine();
    writeStderrLine(terminalError(reviewing ? 'Unable to complete preference review; unconfirmed choices are unchanged.' : 'Unable to read or validate local preferences.', process.stderr));
    const message = reviewing
      ? promptInputState() === 'failed' ? 'Prompt input could not be read.'
        : 'Unable to save preferences; the pending choice is unchanged.'
      : /^(?:Invalid |Config is not valid JSON|Unable to (?:read config|create local config))/.test((error as Error).message)
        ? (error as Error).message : 'Check local config access and structure.';
    writeStderrLine(terminalProse(`${message}\nCheck the config file and its directory, then run ${terminalCommand('ballin setup', process.stderr)} again.`, process.stderr));
    return 'failed';
  }
};
const runSetupCommand = (): void => { process.exitCode = reviewGeneralPreferences(configPath) === 'failed' ? 1 : 0; };
module.exports = { runSetupCommand, reviewGeneralPreferences, setupHelp };
