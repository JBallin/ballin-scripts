const { terminalCommand } = require('./terminalStyle.ts');
const fs = require('fs');
const { savedPreferenceLine } = require('./preference_confirmation.ts');
const { configPath } = require('../config/index.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { configuredBackupDestination, sensitiveSourceConsent } = require('./backup_config.ts');
const { configureAnalyticsPreference } = require('./analytics.ts');
const { saveBackupConfig, reviewAutomaticUpdateBackup, confirmSensitiveSourceChoice, preferenceBoolean } = require('./backup_preferences.ts');
const { rethrowInterruption, writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');

const setupHelp = `Usage:
    ballin setup

Review local sensitive-source, automatic-backup, and analytics preferences. Backup choices appear when a backup is configured; sensitive-source review applies to repository backups.

Use \`ballin config get/set/reset\` for direct configuration. This review does not reinstall Ballin, change backup destinations, or run backup/update.
`;

const cancelSetup = (): void => {
  writeStdoutLine('Preference review cancelled; unconfirmed choices are unchanged. Earlier confirmed choices remain saved.');
  process.exitCode = 0;
};

const runSetupCommand = (): void => {
  let reviewing = false;
  try {
    if (!fs.existsSync(configPath)) throw new Error('Local config is missing.');
    const config = readSetupConfigContext(configPath);
    const destination = configuredBackupDestination(config);
    if (destination.kind === 'invalid') throw new Error('Invalid backup destination configuration.');
    const sensitive = destination.kind === 'repository' ? sensitiveSourceConsent(config) : false;
    if (sensitive === null) throw new Error('Invalid `backup.includeSensitive`; expected true or false.');
    const automatic = destination.kind !== 'unconfigured'
      ? preferenceBoolean(config.update?.backup, 'update.backup') : false;
    const analytics = preferenceBoolean(config.analytics?.enabled, 'analytics.enabled');

    reviewing = true;
    writeStdoutLine('Review your Ballin preferences. Each confirmed choice is saved locally.');
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
      writeStdoutLine(`No backup is configured. Run ${terminalCommand('ballin backup setup')} to choose a destination.`);
    }

    if (destination.kind !== 'unconfigured') {
      const outcome = reviewAutomaticUpdateBackup(configPath, { defaultEnabled: automatic, cancelOnEof: true });
      if (outcome === 'cancelled') { cancelSetup(); return; }
      if (outcome === 'failed') { process.exitCode = 1; return; }
    }
    let cancelled = false;
    if (!configureAnalyticsPreference({ configPath, defaultEnabled: analytics, currentEnabled: analytics, onCancelled: () => { cancelled = true; } })) {
      process.exitCode = 1;
      return;
    }
    if (cancelled) { cancelSetup(); return; }
    writeStdoutLine('\n😎 Ballin preference review complete.');
    process.exitCode = 0;
  } catch (error) {
    rethrowInterruption(error);
    writeStderrLine(`ballin setup: ${(error as Error).message}`);
    writeStderrLine(reviewing
      ? 'Unable to complete preference review; unconfirmed choices are unchanged.'
      : `Repair the local configuration before retrying. Use ${terminalCommand('ballin config get', process.stderr)} to inspect it or ${terminalCommand('ballin config reset', process.stderr)} to restore defaults.`);
    process.exitCode = 1;
  }
};

module.exports = { runSetupCommand, setupHelp };
