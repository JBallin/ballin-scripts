// Public operations shared by dispatch and completion generation; no runtime imports.
const backupCommandNames = ['open', 'read', 'list', 'setup', 'disconnect'] as const;

export type BackupCommandName = typeof backupCommandNames[number];

const isBackupCommandName = (value: unknown): value is BackupCommandName => (
  typeof value === 'string' && backupCommandNames.some((name) => name === value)
);

module.exports = { backupCommandNames, isBackupCommandName };
