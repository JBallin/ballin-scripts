const path = require('path');
const { isHomebrewInstallation, configurationFile, selectedPackageCommand, readPackageMetadata } = require('./installation.ts');
const { configure, readOriginalSetupConfig } = require('../config/setup.ts');
const { configureBackup, setupAnalytics } = require('./install_setup.ts');
const { reviewGeneralPreferences } = require('./setup.ts');
const { readYesNo, promptInputState, CommandInterrupted, writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');
const { terminalError, terminalComplete, terminalProse, terminalCommand } = require('./terminalStyle.ts');

// Onboarding owns user choices only. Homebrew owns installation and command links.
const runPackageSetupCommand = (): void => {
  const repoDir = path.join(__dirname, '..');
  if (!isHomebrewInstallation(repoDir)) {
    writeStderrLine(terminalError('Initial setup is available only for Homebrew installations. Use `ballin setup` to review preferences.', process.stderr));
    process.exitCode = 1;
    return;
  }
  const selected = selectedPackageCommand(repoDir);
  if (selected?.status !== 'pass') {
    writeStderrLine(terminalError(selected?.summary ?? 'Unable to verify the package command.', process.stderr));
    writeStderrLine('Select the Homebrew command on PATH, or reinstall a package with current ownership metadata, then retry. No setup changes were made.');
    process.exitCode = 1;
    return;
  }
  const file = configurationFile(repoDir);
  const originalConfig = readOriginalSetupConfig(file);
  const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';
  if (!originalConfig || !configure(repoDir, docsUrl, file, true)) {
    process.exitCode = 1;
    return;
  }
  const completionRoot = readPackageMetadata(repoDir).completionRoot;
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  const activation = (asset: string): string => {
    const file = quote(path.join(completionRoot, asset));
    return `[[ -r ${file} ]] && source ${file}`;
  };
  writeStdoutLine(terminalProse('Homebrew manages the command and completion assets. To enable Ballin completion, run the command for your shell:'));
  writeStdoutLine(`Zsh:\n${activation('_ballin')}\nBash:\n${activation('ballin.bash')}`);
  writeStdoutLine(terminalProse('To enable it in new terminals, add that command to the startup file your shell reads. Shell startup files are unchanged.'));
  const finish = (cancelled = false): void => {
    setupAnalytics(repoDir, file);
    writeStdoutLine(cancelled ? '\nInitial setup cancelled. Earlier choices saved.' : `\n${terminalComplete('Initial setup complete.')}`);
    writeStdoutLine(terminalProse('Run `ballin setup --initial` to repeat initial setup, `ballin setup` to review preferences, or `ballin backup setup` to configure backups.'));
    process.exitCode = 0;
  };
  let backup: boolean | null;
  try {
    backup = readYesNo('\nConfigure or review your GitHub backup? [y/N] ', false);
  } catch (error) {
    if (error instanceof CommandInterrupted) throw error;
    writeStderrLine(terminalError('\nUnable to read backup setup input. Earlier choices remain saved.', process.stderr));
    writeStderrLine(`Run ${terminalCommand('ballin setup --initial', process.stderr)} to repeat initial setup.`);
    process.exitCode = 1;
    return;
  }
  if (backup === null) { finish(true); return; }
  if (backup) {
    let cancelled = false;
    const succeeded = configureBackup(repoDir, docsUrl, {
      configPath: file, configPrepared: true, originalConfig,
      initialConsent: true, presentation: 'installation', deferFollowUp: true,
      onCancelled: () => { cancelled = true; },
    });
    if (!succeeded) { process.exitCode = 1; return; }
    if (cancelled || promptInputState() !== 'open') { finish(true); return; }
  }
  let preferences: boolean | null;
  try {
    preferences = readYesNo('\nReview your Ballin preferences? [Y/n] ', true);
  } catch (error) {
    if (error instanceof CommandInterrupted) throw error;
    writeStderrLine(terminalError('\nUnable to read preference review input. Earlier choices remain saved.', process.stderr));
    writeStderrLine(`Run ${terminalCommand('ballin setup', process.stderr)} to review preferences.`);
    process.exitCode = 1;
    return;
  }
  if (preferences === null) { finish(true); return; }
  if (preferences) {
    const outcome = reviewGeneralPreferences(file, { installation: true, deferFollowUp: true });
    if (outcome === 'failed') { process.exitCode = 1; return; }
    if (outcome === 'cancelled') { finish(true); return; }
  }
  finish();
};
module.exports = { runPackageSetupCommand };
