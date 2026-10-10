const backupFileSortKey = (fileName: string): string => (
  fileName === 'Brewfile' ? 'brew' : fileName.toLowerCase()
);

const compareBackupFileNames = (left: string, right: string): number => {
  const leftKey = backupFileSortKey(left);
  const rightKey = backupFileSortKey(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

module.exports = { compareBackupFileNames };
