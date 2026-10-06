const defaults = require('./.defaultConfig.json') as Record<string, unknown>;

// Only bundled definitions feed generated assets, never saved user settings.
const configCompletionNames = (settings: Record<string, unknown> = defaults) => {
  const readable: string[] = [];
  const leaves: string[] = [];
  const booleans: string[] = [];
  const visit = (object: Record<string, unknown>, prefix: string): void => {
    for (const [name, value] of Object.entries(object)) {
      const key = prefix ? `${prefix}.${name}` : name;
      readable.push(key);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, key);
      } else {
        leaves.push(key);
        if (typeof value === 'boolean' || value === 'true' || value === 'false') booleans.push(key);
      }
    }
  };
  visit(settings, '');
  return { readable, leaves, booleans };
};

module.exports = { configCompletionNames };
