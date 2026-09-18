const topLevelCommandNames = [
  'backup',
  'config',
  'doctor',
  'self-update',
  'uninstall',
  'update',
] as const;

export type TopLevelCommandName = typeof topLevelCommandNames[number];

const topLevelCommandSet: ReadonlySet<string> = new Set(topLevelCommandNames);

const isTopLevelCommandName = (value: unknown): value is TopLevelCommandName => (
  typeof value === 'string' && topLevelCommandSet.has(value)
);

module.exports = {
  isTopLevelCommandName,
  topLevelCommandNames,
};
