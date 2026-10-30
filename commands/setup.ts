const { terminalCommand, terminalHeading } = require('./terminalStyle.ts');
const fs = require('fs');
const path = require('path');
const { savedPreferenceLine } = require('./preference_confirmation.ts');
const { configPath } = require('../config/index.ts');
const { PortableConfigError, readSetupConfigContext } = require('../config/portable.ts');
const { createDefaultConfig } = require('./install_setup.ts');
const { configuredBackupDestination, sensitiveSourceConsent } = require('./backup_config.ts');
const { configureAnalyticsPreference } = require('./analytics.ts');
const { saveBackupConfig, reviewAutomaticUpdateBackup, confirmSensitiveSourceChoice, preferenceBoolean } = require('./backup_preferences.ts');
const { rethrowInterruption, writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');

const setupHelp = `Usage:
    ballin setup

Review local sensitive-source, automatic-backup, and analytics preferences. Backup choices appear when a backup is configured; sensitive-source review applies to repository backups.

Use \`ballin config get/set/reset\` for direct configuration. This review does not reinstall Ballin, change backup destinations, or run backup/update.

To create, reconnect to, or validate a backup destination, use \`ballin backup setup\`.

🔗 Preference review:
https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#guided-preference-review
`;

const cancelSetup = (): void => {
  writeStdoutLine(`\nReview cancelled. Earlier confirmed choices remain saved.\nRun ${terminalCommand('ballin setup')} to review your preferences again.`);
  process.exitCode = 0;
};

const runSetupCommand = (): void => {
  let reviewing = false;
  let validating = false;
  try {
    try {
      const entry = fs.lstatSync(configPath);
      // A dangling link is an existing, unreadable entry, not a missing config.
      if (entry.isSymbolicLink()) {
        try { fs.statSync(configPath); } catch {
          throw new Error('Unable to read config.');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const repoDir = process.env.BALLIN_TEST_REPO_DIR || path.join(__dirname, '..');
      if (!createDefaultConfig(repoDir, configPath)) {
        writeStderrLine('ballin setup: Unable to create local config. Check the installation and config directory, then retry.');
        process.exitCode = 1;
        return;
      }
    }
    const config = readSetupConfigContext(configPath);
    validating = true;
    const destination = configuredBackupDestination(config);
    if (destination.kind === 'invalid') throw new Error('Invalid backup destination configuration.');
    const sensitive = destination.kind === 'repository' ? sensitiveSourceConsent(config) : false;
    if (sensitive === null) throw new Error('Invalid `backup.includeSensitive`; expected true or false.');
    const automatic = destination.kind !== 'unconfigured'
      ? preferenceBoolean(config.update?.backup, 'update.backup') : false;
    const analytics = preferenceBoolean(config.analytics?.enabled, 'analytics.enabled');

    reviewing = true;
    writeStdoutLine(terminalHeading('Backup preferences'));
    if (destination.kind === 'repository') {
      const included = confirmSensitiveSourceChoice(sensitive);
      if (included === null) { cancelSetup(); return; }
      if (included === undefined) { process.exitCode = 1; return; }
      const current = readSetupConfigContext(configPath);
      const previous = current.backup.includeSensitive;
      current.backup.includeSensitive = String(included);
      if (!saveBackupConfig(configPath, current)) { process.exitCode = 1; return; }
      writeStdoutLine(savedPreferenceLine('backup.includeSensitive', included, previous));
    } else {
      writeStdoutLine(`No backup is configured.\nRun ${terminalCommand('ballin backup setup')} to choose a destination.`);
    }

    if (destination.kind !== 'unconfigured') {
      const outcome = reviewAutomaticUpdateBackup(configPath, { defaultEnabled: automatic, cancelOnEof: true });
      if (outcome === 'cancelled') { cancelSetup(); return; }
      if (outcome === 'failed') { process.exitCode = 1; return; }
    }
    let cancelled = false;
    if (!configureAnalyticsPreference({ configPath, defaultEnabled: analytics, onCancelled: () => { cancelled = true; } })) {
      process.exitCode = 1;
      return;
    }
    if (cancelled) { cancelSetup(); return; }
    writeStdoutLine('\n😎 Ballin preference review complete.');
    process.exitCode = 0;
  } catch (error) {
    rethrowInterruption(error);
    const message = (error as Error).message;
    if (reviewing) {
      writeStderrLine(`ballin setup: ${message}`);
      writeStderrLine('Unable to complete preference review; unconfirmed choices are unchanged.');
    } else if (validating || (error instanceof PortableConfigError && message !== 'Unable to read config.')) {
      const detail = message === 'Config is not valid JSON.' || message === 'Invalid config; expected a JSON object.' ? 'Local config is invalid.' : message;
      writeStderrLine(`ballin setup: ${detail}`);
      writeStderrLine(`Repair the file, or run ${terminalCommand('ballin config reset', process.stderr)} to replace it with defaults.`);
    } else {
      writeStderrLine('ballin setup: Unable to read local config.');
      writeStderrLine('Check that the config file and its parent directory are accessible and readable.');
    }
    process.exitCode = 1;
  }
};

module.exports = { runSetupCommand, setupHelp };
