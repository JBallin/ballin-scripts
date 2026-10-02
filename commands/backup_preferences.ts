const fs = require('fs');
const { createConfigStore, stringify } = require('../config/store.ts');
const { readSetupConfigContext } = require('../config/portable.ts');
const { snapshotDefinitions } = require('./backup_snapshots.ts');
const { readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');
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
type AutomaticBackupOptions = { defaultEnabled?: boolean; cancelOnEof?: boolean };
const reviewAutomaticUpdateBackup = (configPath: string, options: AutomaticBackupOptions = {}): PreferenceOutcome => {
  const defaultEnabled = options.defaultEnabled ?? false;
  const response = readPromptLine(`\n🤔 Automatically run ballin backup after ballin update? ${defaultEnabled ? '[Y/n]' : '[y/N]'} `);
  if (response.eof && options.cancelOnEof) return 'cancelled';
  // Existing destination onboarding treats empty EOF as no; guided review cancels instead.
  const answer = response.eof && !response.text ? 'n' : response.text;
  const enabled = answer === '' ? defaultEnabled : answer === 'y' || answer === 'Y';
  const preference = String(enabled);
  let saved = false;
  if (createConfigStore({ configPath }).readLeafValue('update.backup') !== undefined) {
    try {
      const config = readSetupConfigContext(configPath);
      config.update.backup = preference;
      saved = saveBackupConfig(configPath, config);
    } catch { /* Preserve existing local choices when preference persistence fails. */ }
  }
  if (!saved) {
    writeStdoutLine(options.cancelOnEof
      ? 'Unable to save the automatic-backup preference; the existing local setting is unchanged.'
      : `\nℹ️  Backup setup completed, but the automatic update backup preference was not saved. Edit ballin.config.json and set update.backup to ${preference}.`);
    return 'failed';
  }
  writeStdoutLine(`"update.backup" set to: ${JSON.stringify(preference)}`);
  return 'confirmed';
};
const offerAutomaticUpdateBackup = (configPath: string): boolean => (
  reviewAutomaticUpdateBackup(configPath) === 'confirmed'
);

const displayPath = (value: string): string => JSON.stringify(value);
const reviewSensitiveSources = (homeDir: string, env: NodeJS.ProcessEnv): boolean => {
  for (const definition of snapshotDefinitions as SnapshotDefinition[]) {
    if (definition.inclusionGroup !== 'sensitive') continue;
    const observation = definition.discover({ homeDir, env });
    if (observation.status === 'discovery-failed') {
      writeStdoutLine(`Unable to review ${definition.name}: source access failed.`);
      return false;
    }
    if (definition.name === 'pipx') {
      writeStdoutLine(`pipx: ${observation.status}; installation metadata may contain original URLs, credentials, and backend arguments; no collector is run for review.`);
      continue;
    }
    if (observation.status !== 'available') {
      writeStdoutLine(`${definition.name}: ${observation.status}`);
      continue;
    }
    try {
      const logical = observation.source.path;
      if (!logical || !['file', 'directory'].includes(observation.source.kind)) throw new Error('Unsupported review source');
      const resolved = fs.realpathSync(logical);
      const stat = fs.statSync(resolved);
      if (observation.source.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unsupported source type');
      fs.accessSync(resolved, fs.constants.R_OK);
      writeStdoutLine(`${definition.name}: ${displayPath(logical)} -> ${displayPath(resolved)}`);
    } catch {
      writeStdoutLine(`Unable to review ${definition.name}: resolution or read access failed.`);
      return false;
    }
  }
  return true;
};
// Selection and non-content inspection are shared; destination confirmation belongs to its caller.
const selectSensitiveSources = (defaultIncluded = false): boolean | null | undefined => {
  writeStdoutLine('The fixed inventory and filtered-preference baseline can include private tools, identities, paths, or URLs. It is not guaranteed secret-free.');
  writeStdoutLine('Codex includes whole configuration files (including embedded trust settings), hook definitions, recursive skills/rules/agents, and the personal marketplace manifest. Referenced files and plugin payloads are excluded; nothing is automatically restored or executed.');
  const sensitive = readPromptLine(`Also include sensitive sources (raw shell/Git/editor/Codex configuration, .nvmrc, and pipx installation metadata)? ${defaultIncluded ? '[Y/n]' : '[y/N]'} `);
  if (sensitive.eof) return null;
  const includeSensitive = sensitive.text === '' ? defaultIncluded : /^[yY]$/u.test(sensitive.text);
  if (includeSensitive) {
    if (!process.env.HOME) { writeStdoutLine('HOME is required to review sensitive sources.'); return undefined; }
    if (!reviewSensitiveSources(process.env.HOME, process.env)) return undefined;
  }
  writeStdoutLine(`Selected: inventory and filtered preferences; sensitive sources ${includeSensitive ? 'included' : 'excluded'}.`);
  writeStdoutLine('Consent covers future captures as files, symlink targets, and installed metadata change; Ballin does not detect or redact credentials. Exclusion does not remove saved history.');
  return includeSensitive;
};

module.exports = { saveBackupConfig, offerAutomaticUpdateBackup, reviewAutomaticUpdateBackup, selectSensitiveSources };
