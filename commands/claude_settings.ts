const path = require('path');
const { isUtf8 } = require('node:buffer');
const { claudeSettings: scope } = require('./backup_scope.json') as typeof import('./backup_scope.json');
const { inDirectory, readBoundedFile, requireWithinLimit, snapshotByteLimit } = require('./recursive_snapshot.ts');

type Settings = Record<string, unknown>;
class ClaudeSettingsError extends Error {}
const isObject = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown, key: string): Settings => {
  if (!isObject(value)) throw new ClaudeSettingsError(`Invalid ${key}; expected a JSON object.`);
  return value;
};
const boolean = (value: unknown): boolean => typeof value === 'boolean';
const string = (value: unknown): boolean => typeof value === 'string';
const effortLevels = ['low', 'medium', 'high', 'xhigh'];
const effort = (value: unknown): boolean => effortLevels.includes(value as string);
const effortCap = (value: unknown): boolean => [...effortLevels, 'max'].includes(value as string);
const scalarValidators: Record<string, (value: unknown) => boolean> = {
  model: string, effortLevel: effort, alwaysThinkingEnabled: boolean,
  language: string, outputStyle: string, theme: string, verbose: boolean,
  editorMode: (value) => ['normal', 'vim'].includes(value as string),
  viewMode: (value) => ['default', 'verbose', 'focus'].includes(value as string),
  spinnerTipsEnabled: boolean, terminalProgressBarEnabled: boolean,
  showTurnDuration: boolean, prefersReducedMotion: boolean,
};
const projectLeaves = (input: Settings, keys: readonly string[], validators: Record<string, (value: unknown) => boolean>, section: string): Settings => (
  Object.fromEntries([...keys].sort().flatMap((key) => {
    if (!Object.hasOwn(input, key)) return [];
    if (!Object.hasOwn(validators, key) || !validators[key](input[key])) {
      throw new ClaudeSettingsError(`Invalid ${section}${key}.`);
    }
    return [[key, input[key]]];
  }))
);

const projectClaudeSettings = (value: unknown): Settings => {
  const input = object(value, 'settings');
  return Object.fromEntries([...scope.keys].sort().flatMap((key) => {
    if (!Object.hasOwn(input, key)) return [];
    if (key === 'attribution') {
      const attribution = input[key] === false ? false : projectLeaves(object(input[key], key), scope.attributionKeys,
        { commit: string, pr: string, sessionUrl: boolean }, 'attribution.');
      return [[key, attribution]];
    }
    if (key === 'modelSettings') {
      const models = object(input[key], key);
      const projected = Object.fromEntries(Object.keys(models).sort().flatMap((model) => {
        // Model identifiers are arbitrary private text; never include them in errors.
        const settings = projectLeaves(object(models[model], key), scope.modelKeys,
          { effortLevel: effort, maxEffortLevel: effortCap }, 'modelSettings.');
        return Object.keys(settings).length ? [[model, settings]] : [];
      }));
      return [[key, projected]];
    }
    return Object.entries(projectLeaves(input, [key], scalarValidators, 'settings.'));
  }));
};

// Reject ambiguous admitted members, including escaped spellings. Excluded
// objects are not schema-validated. Syntax is validated before tokenization.
const requireUniqueSettings = (text: string): void => {
  type Kind = 'root' | 'attribution' | 'models' | 'model' | 'excluded';
  const contexts: { array: boolean; key: boolean; field?: string; kind: Kind; seen: Set<string> }[] = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/gu)) {
    if (token === '{' || token === '[') {
      const parent = contexts.at(-1);
      const kind: Kind = !parent ? 'root' : parent.array ? 'excluded'
        : parent.kind === 'root' && parent.field === 'attribution' && scope.keys.includes('attribution') ? 'attribution'
          : parent.kind === 'root' && parent.field === 'modelSettings' && scope.keys.includes('modelSettings') ? 'models'
            : parent.kind === 'models' ? 'model' : 'excluded';
      contexts.push({ array: token === '[', key: token === '{', kind, seen: new Set() });
    } else if (token === '}' || token === ']') contexts.pop();
    else {
      const context = contexts.at(-1);
      if (!context || context.array) continue;
      if (token === ',') context.key = true;
      else if (context.key) {
        const key = JSON.parse(token);
        const selected = context.kind === 'root' ? scope.keys.includes(key)
          : context.kind === 'attribution' ? scope.attributionKeys.includes(key)
            : context.kind === 'model' ? scope.modelKeys.includes(key) : context.kind === 'models';
        if (selected && context.seen.has(key)) throw new ClaudeSettingsError('Duplicate admitted setting key.');
        if (selected) context.seen.add(key);
        context.field = key;
        context.key = false;
      }
    }
  }
};

const serializeClaudeSettings = (text: string): string => {
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new ClaudeSettingsError('Settings are not valid JSON.'); }
  requireUniqueSettings(text);
  return `${JSON.stringify(projectClaudeSettings(input), null, 2)}\n`;
};

const captureClaudeSettings = (root: string, relative: string, maxBytes = snapshotByteLimit): string => {
  // Bound the entire source before parsing, independently of the remaining
  // aggregate output allowance. Never stage the raw settings file.
  const bytes: Buffer = inDirectory(root, path.dirname(relative), () => readBoundedFile(path.basename(relative), snapshotByteLimit, true).bytes);
  if (!isUtf8(bytes)) throw new ClaudeSettingsError('Settings are not valid UTF-8.');
  const output = serializeClaudeSettings(bytes.toString('utf8'));
  requireWithinLimit('bytes', Buffer.byteLength(output), maxBytes);
  return output;
};

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args[1] !== 'file' || !args[2]) throw new ClaudeSettingsError('Invalid collector arguments.');
    const flags = args.slice(3);
    if (flags[0] === '--reject-hardlinks') flags.shift();
    const maxBytes = flags.length === 0 ? snapshotByteLimit
      : flags.length === 2 && flags[0] === '--max-bytes' ? Number(flags[1]) : NaN;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > snapshotByteLimit) {
      throw new ClaudeSettingsError('Invalid snapshot limit.');
    }
    process.stdout.write(captureClaudeSettings(args[0], args[2], maxBytes));
  } catch (error) {
    const message = error instanceof ClaudeSettingsError ? error.message : 'Unable to capture Claude settings.';
    process.stderr.write(`ballin Claude settings: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { projectClaudeSettings, serializeClaudeSettings, captureClaudeSettings };
