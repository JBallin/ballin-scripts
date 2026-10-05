const fs = require('fs');
const path = require('path');
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
  const response = readPromptLine(`\n🤔 Automatically run \`ballin backup\` as part of \`ballin update\`? ${defaultEnabled ? '[Y/n]' : '[y/N]'} `);
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
      : `Backup destination saved, but the automatic-backup preference was not saved. Set \`update.backup\` to ${preference} in \`ballin.config.json\`.`);
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
  const sensitiveDefinitions = (snapshotDefinitions as readonly SnapshotDefinition[])
    .filter((definition) => definition.inclusionGroup === 'sensitive')
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const available: string[] = [];
  const absent: string[] = [];
  const unavailable: string[] = [];
  for (const definition of sensitiveDefinitions) {
    const observation = definition.discover({ homeDir, env });
    if (observation.status === 'discovery-failed') {
      writeStdoutLine(`Unable to review ${definition.name}: source access failed.`);
      return false;
    }
    if (observation.status !== 'available') {
      (observation.status === 'absent' ? absent : unavailable).push(definition.name);
      continue;
    }
    if (definition.name === 'pipx') {
      available.push('pipx: installation metadata');
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
      available.push(`${definition.name}: ${displayPath(logical)}${logical === resolved ? '' : ` -> ${displayPath(resolved)}`}`);
    } catch (error) {
      if (error instanceof require('./recursive_snapshot.ts').SnapshotCwdError) throw error;
      writeStdoutLine(`Unable to review ${definition.name}: resolution or read access failed.`);
      return false;
    }
  }
  writeStdoutLine();
  writeStdoutLine(available.length ? 'Sensitive sources available now:' : 'Sensitive sources available now: none.');
  available.forEach((line) => writeStdoutLine(`  ${line}`));
  if (absent.length) writeStdoutLine(`Not found now: ${absent.join(', ')}`);
  if (unavailable.length) writeStdoutLine(`Unavailable now: ${unavailable.join(', ')}`);
  writeStdoutLine('pipx installation metadata may contain original URLs, credentials, and backend arguments.');
  writeStdoutLine('This review checks paths and availability; it reads no file contents and runs no collectors.');
  return true;
};
// Selection and non-content inspection are shared; destination confirmation belongs to its caller.
const selectSensitiveSources = (defaultIncluded = false): boolean | null | undefined => {
  writeStdoutLine('\nTool inventories and filtered preferences can include private tools, identities, paths, or URLs.');
  writeStdoutLine('Even without sensitive sources, backups may contain secrets.');
  writeStdoutLine('Sensitive sources include raw shell, Git, and editor configuration,');
  writeStdoutLine('Codex and Claude Code configuration, Node.js version files (.nvmrc),');
  writeStdoutLine('and pipx installation metadata.');
  writeStdoutLine('Codex includes whole configuration files (including embedded trust settings),');
  writeStdoutLine('hook definitions, recursive skills/rules/agents, and the personal marketplace manifest.');
  writeStdoutLine('Referenced files and plugin payloads are excluded; nothing is automatically restored or executed.');
  writeStdoutLine('Claude Code includes personal CLAUDE.md, Markdown rules/agents/commands, and eligible skills.');
  writeStdoutLine('Claude skills include downloaded defaults, organization-provided and plugin-origin synced packages.');
  writeStdoutLine('Skill folders include hidden files, executable scripts, and binary supporting assets.');
  writeStdoutLine('Settings, credential stores, runtime state, sync bookkeeping, and plugin installations are excluded.');
  writeStdoutLine('Selected content may contain secrets; Ballin does not scan or redact it.');
  writeStdoutLine('Opting in covers all currently supported sensitive sources and future additions to this maintained catalog.');
  writeStdoutLine('Review: https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md');
  const sensitive = readPromptLine(`Also include sensitive sources? ${defaultIncluded ? '[Y/n]' : '[y/N]'} `);
  if (sensitive.eof) return null;
  const includeSensitive = sensitive.text === '' ? defaultIncluded : /^[yY]$/u.test(sensitive.text);
  if (includeSensitive) {
    if (!process.env.HOME) { writeStdoutLine('HOME is required to review sensitive sources.'); return undefined; }
    if (!reviewSensitiveSources(process.env.HOME, process.env)) return undefined;
  }
  writeStdoutLine(`\nSelected: inventory and filtered preferences; sensitive sources ${includeSensitive ? 'included' : 'excluded'}.`);
  writeStdoutLine('This choice applies to future backups as files, symlink targets, and installed metadata change.');
  writeStdoutLine('Ballin does not detect or redact credentials. Excluding sources does not remove saved files or history.');
  return includeSensitive;
};

module.exports = { saveBackupConfig, offerAutomaticUpdateBackup, reviewAutomaticUpdateBackup, selectSensitiveSources };
