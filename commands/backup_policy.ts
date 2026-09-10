const fs = require('fs');
const { resolveBackupInclusion } = require('../config/portable.ts');
const { snapshotDefinitions } = require('./backup_snapshots.ts');

import type { BackupInclusion, InclusionProposals } from '../config/portable.ts';
import type { SnapshotDefinition, SnapshotDiscoveryContext } from './backup_snapshots.ts';

type BackupInclusionReviewOptions = {
  localConfig: unknown;
  proposals?: InclusionProposals;
  context: SnapshotDiscoveryContext;
  readPrompt: (prompt: string) => string | null;
  writeLine: (message: string) => void;
};

type BackupInclusionReviewResult =
  | { status: 'confirmed'; inclusion: BackupInclusion }
  | { status: 'cancelled' }
  | { status: 'failed' };

// Return a decision for the caller to persist with its destination transition.
// Review does not collect content, run inventory tools, or change config.
const reviewBackupInclusion = ({
  localConfig,
  proposals = {},
  context,
  readPrompt,
  writeLine,
}: BackupInclusionReviewOptions): BackupInclusionReviewResult => {
  let local: BackupInclusion;
  try {
    local = resolveBackupInclusion(localConfig);
  } catch {
    writeLine('Unable to review backup inclusion; repair invalid local configuration first.');
    return { status: 'failed' };
  }

  const namesFor = (group: SnapshotDefinition['inclusionGroup']): string => (
    snapshotDefinitions
      .filter((definition: SnapshotDefinition) => definition.inclusionGroup === group)
      .map((definition: SnapshotDefinition) => definition.name)
      .join(', ')
  );
  writeLine(`Inventory included by default: ${namesFor('inventory')}.`);
  writeLine('These inventories reveal installed tools and potentially organizational preferences. They are not guaranteed secret-free.');
  writeLine('Portable Ballin preferences are included using the explicit export allowlist.');
  writeLine('Raw configuration and detailed inventories can contain credentials, private URLs, identities, paths, and arbitrary sensitive values.');
  writeLine('Inclusion authorizes subsequent captures as files and symlink targets change. Ballin does not scan or redact contents or guarantee that future credentials will be detected.');
  writeLine('Accept only the access boundary of your selected destination; a secret Gist is unlisted, not private.');

  if (proposals.includeRaw !== undefined || proposals.includeDetailed !== undefined) {
    writeLine('Restored inclusion preferences are proposals only; they do not change the local choices used as defaults below.');
    if (proposals.includeRaw !== undefined) {
      writeLine(`Restored raw configuration preference: ${proposals.includeRaw ? 'include' : 'exclude'}.`);
    }
    if (proposals.includeDetailed !== undefined) {
      writeLine(`Restored detailed inventory preference: ${proposals.includeDetailed ? 'include' : 'exclude'}.`);
    }
  }

  const readChoice = (label: string, defaultChoice: boolean): boolean | null => {
    while (true) {
      const response = readPrompt(`${label} ${defaultChoice ? '[Y/n]' : '[y/N]'}: `);
      if (response === null) {
        return null;
      }
      const answer = response.trim().toLowerCase();
      if (!answer) {
        return defaultChoice;
      }
      if (answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      writeLine('Enter yes or no, or press Enter for the displayed default.');
    }
  };

  const includeRaw = readChoice('Include raw shell, Git, editor configuration and .nvmrc?', local.includeRaw);
  if (includeRaw === null) {
    return { status: 'cancelled' };
  }
  writeLine(`Detailed inventories: ${namesFor('detailed')}.`);
  const includeDetailed = readChoice('Include detailed inventories?', local.includeDetailed);
  if (includeDetailed === null) {
    return { status: 'cancelled' };
  }

  if (includeRaw) {
    writeLine('Review selected raw sources (logical path -> resolved file):');
    for (const definition of snapshotDefinitions as readonly SnapshotDefinition[]) {
      if (definition.inclusionGroup !== 'raw') {
        continue;
      }
      try {
        const observation = definition.discover(context);
        if (observation.status === 'discovery-failed') {
          writeLine(`Unable to review ${definition.name}: source discovery failed.`);
          return { status: 'failed' };
        }
        if (observation.status !== 'available') {
          writeLine(`  ${definition.name}: ${observation.status} (${observation.reason}).`);
          continue;
        }
        const sourcePath = observation.source.path;
        if (!sourcePath) {
          writeLine(`Unable to review ${definition.name}: no file source was resolved.`);
          return { status: 'failed' };
        }
        const resolvedPath = fs.realpathSync(sourcePath);
        writeLine(`  ${definition.name}: ${JSON.stringify(sourcePath)} -> ${JSON.stringify(resolvedPath)}`);
      } catch {
        writeLine(`Unable to review ${definition.name}: source access or resolution failed.`);
        return { status: 'failed' };
      }
    }
  }
  writeLine(`Raw configuration: ${includeRaw ? 'included' : 'excluded'}. Detailed inventories: ${includeDetailed ? 'included' : 'excluded'}.`);
  if (readChoice('Confirm this inclusion selection?', false) !== true) {
    return { status: 'cancelled' };
  }
  return { status: 'confirmed', inclusion: { includeRaw, includeDetailed } };
};

module.exports = { reviewBackupInclusion };

export type { BackupInclusionReviewOptions, BackupInclusionReviewResult };
