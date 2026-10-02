const fs = require('fs');
const { configPath } = require('../config/index.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { configuredBackupDestination, sensitiveSourceConsent } = require('./backup_config.ts');
const { configureAnalyticsPreference } = require('./analytics.ts');
const { saveBackupConfig, reviewAutomaticUpdateBackup, selectSensitiveSources } = require('./backup_preferences.ts');
const { readPromptLine, writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');

const setupHelp = `Usage:
    ballin setup
    ballin setup --help

Review local sensitive-source, automatic-backup, and analytics preferences.
Backup choices appear when a backup is configured; sensitive-source review applies to repository backups.
Use ballin config get/set/reset for direct configuration.
This review does not reinstall Ballin, change backup destinations, or run backup/update.
`;

const preferenceBoolean = (value: unknown, key: string): boolean => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Invalid ${key}; expected true or false.`);
};
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
    if (sensitive === null) throw new Error('Invalid backup.includeSensitive; expected true or false.');
    const automatic = destination.kind !== 'unconfigured'
      ? preferenceBoolean(config.update?.backup, 'update.backup') : false;
    const analytics = preferenceBoolean(config.analytics?.enabled, 'analytics.enabled');

    reviewing = true;
    writeStdoutLine('Review your Ballin preferences. Each confirmed choice is saved locally.');
    writeStdoutLine('Details: https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md');
    if (destination.kind === 'repository') {
      const included = selectSensitiveSources(sensitive);
      if (included === null) { cancelSetup(); return; }
      if (included === undefined) { process.exitCode = 1; return; }
      const confirmation = readPromptLine('Save this sensitive-source choice for future backups? [y/N] ');
      if (confirmation.eof || !/^[yY]$/u.test(confirmation.text)) { cancelSetup(); return; }
      const current = readSetupConfigContext(configPath);
      current.backup.includeSensitive = String(included);
      if (!saveBackupConfig(configPath, current)) { process.exitCode = 1; return; }
      writeStdoutLine(`"backup.includeSensitive" set to: ${JSON.stringify(String(included))}`);
    } else if (destination.kind === 'legacy-gist') {
      writeStdoutLine('Legacy Gist backups capture every available source; sensitive-source selection applies to repository backups.');
    } else {
      writeStdoutLine('No backup is configured. Run ballin backup setup to choose a destination.');
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
    writeStdoutLine('Ballin preference review complete.');
    process.exitCode = 0;
  } catch (error) {
    writeStderrLine(`ballin setup: ${(error as Error).message}`);
    writeStderrLine(reviewing
      ? 'Unable to complete preference review; unconfirmed choices are unchanged.'
      : 'Repair the local configuration before retrying. Use ballin config get to inspect it or ballin config reset to restore defaults.');
    process.exitCode = 1;
  }
};

module.exports = { runSetupCommand, setupHelp };
