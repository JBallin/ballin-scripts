const { terminalCommand, terminalPath } = require('./terminalStyle.ts');
const fs = require('fs');
const path = require('path');
const { createConfigStore, stringify } = require('../config/store.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { savedPreferenceLine } = require('./preference_confirmation.ts');
const { snapshotDefinitions } = require('./backup_snapshots.ts');
const { readYesNo, writeStdoutLine } = require('./commandHelpers.ts');
import type { SnapshotDefinition } from './backup_snapshots.ts';

export type PreferenceOutcome = 'confirmed' | 'cancelled' | 'failed';

const saveBackupConfig = (configPath: string, config: Record<string, unknown>): boolean => {
  const temporary = `${configPath}.${process.pid}.backup.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, stringify(config)); } finally { fs.closeSync(fd); }
    if (process.env.BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT === '1') throw new Error('Simulated final config commit failure');
    fs.renameSync(temporary, configPath);
    return true;
  } catch {
    writeStdoutLine('Unable to save backup configuration; the previous destination and local choices remain authoritative.');
    return false;
  } finally {
    if (created) {
      try { fs.rmSync(temporary, { force: true }); } catch { writeStdoutLine('Unable to remove a private backup configuration staging file.'); }
    }
  }
};
const preferenceBoolean = (value: unknown, key: string): boolean => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Invalid \`${key}\`; expected true or false.`);
};
type AutomaticBackupOptions = { defaultEnabled?: boolean; cancelOnEof?: boolean; presentation?: 'installation' | 'standalone'; validateConfig?: (config: ReturnType<typeof readSetupConfigContext>) => boolean };
const selectAutomaticUpdateBackup = (options: AutomaticBackupOptions = {}): boolean | null => {
  const defaultEnabled = options.defaultEnabled ?? false;
  return readYesNo(`\nAutomatically run ${terminalCommand('ballin backup')} as part of ${terminalCommand('ballin update')}? ${defaultEnabled ? '[Y/n]' : '[y/N]'} `, defaultEnabled);
};
const reviewAutomaticUpdateBackup = (configPath: string, options: AutomaticBackupOptions = {}): PreferenceOutcome => {
  const enabled = selectAutomaticUpdateBackup(options);
  if (enabled === null) return 'cancelled';
  const preference = String(enabled);
  let saved = false;
  let previous: unknown;
  if (createConfigStore({ configPath }).readLeafValue('update.backup') !== undefined) {
    try {
      const config = readSetupConfigContext(configPath);
      if (options.validateConfig && !options.validateConfig(config)) return 'failed';
      previous = config.update.backup;
      config.update.backup = preference;
      saved = saveBackupConfig(configPath, config);
    } catch { /* Preserve existing local choices when preference persistence fails. */ }
  }
  if (!saved) {
    writeStdoutLine(options.cancelOnEof
      ? 'Unable to save the automatic-backup preference; the existing local setting is unchanged.'
      : `Backup destination saved, but the automatic-backup preference was not saved. Set \`update.backup\` to ${preference} in \`ballin.config.json\`.`);
    return 'failed';
  }
  if (options.presentation !== 'installation') writeStdoutLine(savedPreferenceLine('update.backup', enabled, previous));
  return 'confirmed';
};
const offerAutomaticUpdateBackup = (configPath: string): boolean => (
  reviewAutomaticUpdateBackup(configPath) !== 'failed'
);

// Quote unusual paths so control sequences cannot alter the terminal or impersonate another line.
const displayPath = (value: string): string => {
  const unsafe = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
  if (!unsafe.test(value)) return value;
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (character) => (
    Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join('')
  ));
};
const reviewSensitiveSources = (homeDir: string, env: NodeJS.ProcessEnv): boolean => {
  const sensitiveDefinitions = (snapshotDefinitions as readonly SnapshotDefinition[])
    .filter((definition) => definition.inclusionGroup === 'sensitive')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const available: string[] = [];
  let pipxAvailable = false;
  let actualHome = homeDir;
  try { actualHome = fs.realpathSync(homeDir); } catch { /* Preserve normal source discovery errors. */ }
  for (const definition of sensitiveDefinitions) {
    const observation = definition.discover({ homeDir, env });
    if (observation.status === 'discovery-failed') {
      writeStdoutLine(`Unable to review ${definition.name}: source access failed.`);
      return false;
    }
    if (observation.status !== 'available') {
      continue;
    }
    if (definition.name === 'pipx') {
      pipxAvailable = true;
      continue;
    }
    try {
      const logical = observation.source.path;
      if (!logical || !['file', 'directory'].includes(observation.source.kind)) throw new Error('Unsupported review source');
      let resolved: string;
      if (definition.category === 'codex' || definition.category === 'claude') {
        const { fileStat, reviewRecursiveFiles, sourceStat } = require('./recursive_snapshot.ts');
        const args = observation.collector.args;
        if (!args || !args[1]) throw new Error('Unsupported review source');
        resolved = observation.source.kind === 'directory' ? args[1] : path.join(args[1], args[3]);
        if (observation.source.kind === 'directory') {
          if (!sourceStat(path.dirname(resolved), path.basename(resolved)).isDirectory()) throw new Error('Unsupported source type');
          reviewRecursiveFiles(resolved, args[2] === 'profiles', args[2] === 'skills', {}, {
            markdownOnly: args[2] === 'markdown', claudeSkills: args[2] === 'claude-skills', rejectHardlinks: definition.category === 'claude',
          });
        } else {
          fileStat(args[1], args[3], definition.category === 'claude');
        }
      } else {
        resolved = fs.realpathSync(logical);
        const stat = fs.statSync(resolved);
        if (observation.source.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unsupported source type');
        fs.accessSync(resolved, fs.constants.R_OK);
      }
      available.push(displayPath(terminalPath(resolved, actualHome)));
    } catch (error) {
      if (error instanceof require('./recursive_snapshot.ts').SnapshotCwdError) throw error;
      writeStdoutLine(`Unable to review ${definition.name}: resolution or read access failed.`);
      return false;
    }
  }
  writeStdoutLine();
  writeStdoutLine(available.length ? 'Sensitive source paths available now:' : 'Sensitive source paths available now: none.');
  [...new Set(available)].forEach((line) => writeStdoutLine(`  ${line}`));
  if (pipxAvailable) writeStdoutLine('pipx installation metadata is also available.');
  return true;
};
// Selection and source review are shared; destination confirmation belongs to its caller.
const selectSensitiveSources = (defaultIncluded = false): boolean | null | undefined => {
  writeStdoutLine('ℹ️  Inventories and filtered preferences can contain private information or secrets even without sensitive sources.');
  writeStdoutLine('🔗 Backup source details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md#what-will-ballin-back-up');
  let reviewSucceeded = false;
  if (!process.env.HOME) writeStdoutLine('HOME is required to review sensitive sources.');
  else reviewSucceeded = reviewSensitiveSources(process.env.HOME, process.env);
  const included = readYesNo(`Include sensitive sources in future backups? ${defaultIncluded ? '[Y/n]' : '[y/N]'} `, defaultIncluded);
  if (included === true && !reviewSucceeded) return undefined;
  return included;
};

const confirmSensitiveSourceChoice = (defaultIncluded: boolean): boolean | null | undefined => (
  selectSensitiveSources(defaultIncluded)
);

module.exports = {
  saveBackupConfig, offerAutomaticUpdateBackup, reviewAutomaticUpdateBackup, selectSensitiveSources,
  preferenceBoolean, selectAutomaticUpdateBackup, confirmSensitiveSourceChoice,
};
