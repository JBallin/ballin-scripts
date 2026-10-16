// Only explicit onboarding preferences belong here, never arbitrary config values.
const preferences = {
  'backup.includeSensitive': ['Sensitive sources in backups', 'included', 'excluded'],
  'update.backup': ['Automatic backup during updates', 'enabled', 'disabled'],
  'analytics.enabled': ['Usage analytics', 'enabled', 'disabled'],
} as const;

const savedPreferenceLine = (key: keyof typeof preferences, enabled: boolean, previous: unknown): string => {
  const [description, yes, no] = preferences[key];
  const unchanged = previous === enabled || previous === String(enabled);
  return `${description}: ${enabled ? yes : no} (\`${key}\` ${unchanged ? 'unchanged at' : 'set to'} \`${enabled}\`).`;
};

module.exports = { savedPreferenceLine };
