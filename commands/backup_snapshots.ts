const fs = require('fs');
const path = require('path');
const backupScope = require('./backup_scope.json') as typeof import('./backup_scope.json');
const {
  runCommand,
} = require('./commandHelpers.ts');

type SnapshotInclusionGroup = 'inventory' | 'sensitive' | 'preferences';

type SnapshotCategory =
  | 'shell'
  | 'bash-completions'
  | 'homebrew'
  | 'git'
  | 'npm'
  | 'python'
  | 'node'
  | 'vscode'
  | 'vscode-insiders'
  | 'editor'
  | 'ballin'
  | 'mas'
  | 'codex'
  | 'claude';

type SnapshotCommand = {
  fileName: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  suppressStderrOnSuccess?: boolean;
};

type SnapshotPrerequisite = {
  kind: 'application' | 'directory' | 'file' | 'tool';
  name: string;
};

type SnapshotSourceReference = {
  kind: 'application' | 'directory' | 'file' | 'tool';
  name: string;
  path?: string;
  root?: string;
};

type AvailableSnapshotSource = {
  status: 'available';
  source: SnapshotSourceReference;
  collector: SnapshotCommand;
};

type AbsentSnapshotSource = {
  status: 'absent';
  source: SnapshotSourceReference;
  reason: 'source-not-found';
};

type UnavailableSnapshotSource = {
  status: 'unavailable';
  source: SnapshotSourceReference;
  reason: 'app-unavailable' | 'tool-unavailable' | 'unsupported-source-type';
};

type FailedSnapshotDiscovery = {
  status: 'discovery-failed';
  source: SnapshotSourceReference;
  reason: 'prerequisite-command-failed' | 'source-access-failed' | 'tool-discovery-failed' | 'source-limit-exceeded';
  error?: Error;
  exitStatus?: number | null;
  signal?: NodeJS.Signals | null;
};

type SnapshotSourceDiscovery =
  | AvailableSnapshotSource
  | AbsentSnapshotSource
  | UnavailableSnapshotSource
  | FailedSnapshotDiscovery;

type SnapshotDiscoveryContext = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
};

type SnapshotDefinition = {
  name: string;
  directory?: boolean;
  category: SnapshotCategory;
  inclusionGroup: SnapshotInclusionGroup;
  prerequisites: readonly SnapshotPrerequisite[];
  discover: (context: SnapshotDiscoveryContext) => SnapshotSourceDiscovery;
};

type ExcludedSnapshotSource = {
  status: 'excluded-by-policy';
  reason: 'excluded-by-policy';
};

type SnapshotSourceObservation = (SnapshotSourceDiscovery | ExcludedSnapshotSource) & {
  definition: SnapshotDefinition;
};

type AvailableSnapshotObservation = SnapshotSourceObservation & AvailableSnapshotSource;
type SkippedSnapshotObservation = Exclude<SnapshotSourceObservation, AvailableSnapshotObservation>;

type SnapshotCaptureResult =
  | { status: 'captured'; localFile: string }
  | { status: 'collector-failed' };

type SnapshotCollectionObservation =
  | {
    status: 'captured';
    source: AvailableSnapshotObservation;
    localFile: string;
  }
  | {
    status: 'skipped';
    source: SkippedSnapshotObservation;
    reason: SkippedSnapshotObservation['reason'];
  }
  | {
    status: 'collector-failed';
    source: AvailableSnapshotObservation;
  };

type SnapshotNameClassification = 'current' | 'reserved' | 'retired' | 'unexpected';

type PathDiscovery =
  | { status: 'available'; path: string }
  | { status: 'absent' }
  | { status: 'unavailable' }
  | { status: 'discovery-failed'; error: Error };

type ToolDiscovery =
  | { status: 'available'; path: string }
  | { status: 'unavailable' }
  | { status: 'discovery-failed'; error: Error };

const emptySnapshotContent = 'empty\n';
const configSnapshotFileName = backupScope.preferences.name;
const repositoryMarkerFileName = '.ballin-backup.json';
const repositoryReadmeFileName = 'README.md';

const retiredSnapshotFileNames = new Set([
  'codex_profiles.json', 'codex_skills.json', 'codex_user_skills.json', 'codex_rules.json', 'codex_agents.json',
  'claude_rules', 'claude_agents', 'claude_commands',
  'brackets_disabled_extensions',
  'brackets_extensions',
  'brackets_keymap.json',
  'brackets_settings.json',
]);

const reservedSnapshotFileNames = new Set([
  repositoryMarkerFileName,
  repositoryReadmeFileName,
]);

const errorCode = (error: unknown): string | undefined => (
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
);

const inspectPath = (candidate: string, expected: 'directory' | 'file'): PathDiscovery => {
  try {
    const stat = fs.statSync(candidate);
    const expectedType = expected === 'file' ? stat.isFile() : stat.isDirectory();
    return expectedType
      ? { status: 'available', path: candidate }
      : { status: 'unavailable' };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent' };
    }
    return {
      status: 'discovery-failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

const inspectTool = (tool: string, env: NodeJS.ProcessEnv): ToolDiscovery => {
  const envPath = env.PATH ?? '';
  let discoveryError: Error | null = null;

  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, tool);
    const pathResult = inspectPath(candidate, 'file');
    if (pathResult.status === 'absent' || pathResult.status === 'unavailable') {
      continue;
    }
    if (pathResult.status === 'discovery-failed') {
      discoveryError ??= pathResult.error;
      continue;
    }

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { status: 'available', path: candidate };
    } catch (error) {
      if (errorCode(error) !== 'EACCES') {
        discoveryError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  return discoveryError
    ? { status: 'discovery-failed', error: discoveryError }
    : { status: 'unavailable' };
};

const fileSource = (sourcePath: string, root: string): SnapshotSourceReference => ({
  kind: 'file',
  name: path.basename(sourcePath),
  path: sourcePath,
  root,
});

const directorySource = (directory: string): SnapshotSourceReference => ({
  kind: 'directory',
  name: path.basename(directory),
  path: directory,
});

const toolSource = (tool: string, toolPath?: string, root?: string): SnapshotSourceReference => ({
  kind: 'tool',
  name: tool,
  path: toolPath,
  root,
});

const applicationSource = (application: string, root: string): SnapshotSourceReference => ({
  kind: 'application',
  name: application,
  root,
});

const sourceFromPathDiscovery = (
  discovery: PathDiscovery,
  source: SnapshotSourceReference,
  collector: SnapshotCommand,
): SnapshotSourceDiscovery => {
  if (discovery.status === 'available') {
    return { status: 'available', source, collector };
  }
  if (discovery.status === 'absent') {
    return { status: 'absent', source, reason: 'source-not-found' };
  }
  if (discovery.status === 'unavailable') {
    return { status: 'unavailable', source, reason: 'unsupported-source-type' };
  }
  return {
    status: 'discovery-failed',
    source,
    reason: 'source-access-failed',
    error: discovery.error,
  };
};

const fileSnapshot = (
  category: SnapshotCategory,
  inclusionGroup: SnapshotInclusionGroup,
  name: string,
  relativeSourcePath: string,
): SnapshotDefinition => ({
  name,
  category,
  inclusionGroup,
  prerequisites: [{ kind: 'file', name: relativeSourcePath }],
  discover: ({ homeDir, env }) => {
    const sourcePath = path.join(homeDir, relativeSourcePath);
    return sourceFromPathDiscovery(
      inspectPath(sourcePath, 'file'),
      fileSource(sourcePath, homeDir),
      {
        fileName: name,
        command: 'cat',
        args: [relativeSourcePath],
        cwd: homeDir,
        env,
      },
    );
  },
});

const shellCommandSnapshot = (
  category: SnapshotCategory,
  inclusionGroup: SnapshotInclusionGroup,
  name: string,
  tool: string,
  command: string,
  options: {
    environment?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    suppressStderrOnSuccess?: boolean;
  },
): SnapshotDefinition => ({
  name,
  category,
  inclusionGroup,
  prerequisites: [{ kind: 'tool', name: tool }],
  discover: ({ homeDir, env }) => {
    const toolResult = inspectTool(tool, env);
    const source = toolSource(tool, toolResult.status === 'available' ? toolResult.path : undefined);
    if (toolResult.status === 'unavailable') {
      return { status: 'unavailable', source, reason: 'tool-unavailable' };
    }
    if (toolResult.status === 'discovery-failed') {
      return {
        status: 'discovery-failed',
        source,
        reason: 'tool-discovery-failed',
        error: toolResult.error,
      };
    }
    return {
      status: 'available',
      source,
      collector: {
        fileName: name,
        command: 'bash',
        args: ['-c', command],
        cwd: homeDir,
        env: options.environment?.(env) ?? env,
        suppressStderrOnSuccess: options.suppressStderrOnSuccess,
      },
    };
  },
});

const editorRoot = (homeDir: string, application: string): string => (
  path.join(homeDir, ...backupScope.roots.editor, application, backupScope.roots.editorUser)
);

const editorFileSnapshot = (
  category: SnapshotCategory,
  name: string,
  application: string,
  fileName: string,
): SnapshotDefinition => ({
  name,
  category,
  inclusionGroup: 'sensitive',
  prerequisites: [
    { kind: 'application', name: application },
    { kind: 'file', name: fileName },
  ],
  discover: ({ homeDir, env }) => {
    const root = editorRoot(homeDir, application);
    const applicationResult = inspectPath(root, 'directory');
    const appSource = applicationSource(application, root);
    if (applicationResult.status === 'absent') {
      return { status: 'unavailable', source: appSource, reason: 'app-unavailable' };
    }
    if (applicationResult.status === 'unavailable') {
      return { status: 'unavailable', source: appSource, reason: 'unsupported-source-type' };
    }
    if (applicationResult.status === 'discovery-failed') {
      return {
        status: 'discovery-failed',
        source: appSource,
        reason: 'source-access-failed',
        error: applicationResult.error,
      };
    }

    const sourcePath = path.join(root, fileName);
    return sourceFromPathDiscovery(
      inspectPath(sourcePath, 'file'),
      fileSource(sourcePath, root),
      {
        fileName: name,
        command: 'cat',
        args: [fileName],
        cwd: root,
        env,
      },
    );
  },
});

const editorExtensionsSnapshot = (
  category: SnapshotCategory,
  name: string,
  application: string,
  tool: string,
): SnapshotDefinition => ({
  name,
  category,
  inclusionGroup: 'inventory',
  prerequisites: [
    { kind: 'application', name: application },
    { kind: 'tool', name: tool },
  ],
  discover: ({ homeDir, env }) => {
    const root = editorRoot(homeDir, application);
    const applicationResult = inspectPath(root, 'directory');
    const appSource = applicationSource(application, root);
    if (applicationResult.status === 'absent') {
      return { status: 'unavailable', source: appSource, reason: 'app-unavailable' };
    }
    if (applicationResult.status === 'unavailable') {
      return { status: 'unavailable', source: appSource, reason: 'unsupported-source-type' };
    }
    if (applicationResult.status === 'discovery-failed') {
      return {
        status: 'discovery-failed',
        source: appSource,
        reason: 'source-access-failed',
        error: applicationResult.error,
      };
    }

    const toolResult = inspectTool(tool, env);
    const source = toolSource(tool, toolResult.status === 'available' ? toolResult.path : undefined, root);
    if (toolResult.status === 'unavailable') {
      return { status: 'unavailable', source, reason: 'tool-unavailable' };
    }
    if (toolResult.status === 'discovery-failed') {
      return {
        status: 'discovery-failed',
        source,
        reason: 'tool-discovery-failed',
        error: toolResult.error,
      };
    }
    return {
      status: 'available',
      source,
      collector: {
        fileName: name,
        command: 'bash',
        args: ['-c', `${tool} --list-extensions`],
        cwd: root,
        env,
      },
    };
  },
});

const brewEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
});

const bashCompletionsSnapshot = (): SnapshotDefinition => ({
  name: backupScope.bashCompletions.name,
  category: 'bash-completions',
  inclusionGroup: 'inventory',
  prerequisites: [{ kind: 'directory', name: 'active Homebrew bash completion directory' }],
  discover: ({ env }) => {
    const override = env[backupScope.bashCompletions.environment] ?? '';
    let completionDirectory = override;
    let toolPath: string | undefined;

    if (!completionDirectory) {
      const toolResult = inspectTool('brew', env);
      const source = toolSource('brew', toolResult.status === 'available' ? toolResult.path : undefined);
      if (toolResult.status === 'unavailable') {
        return { status: 'unavailable', source, reason: 'tool-unavailable' };
      }
      if (toolResult.status === 'discovery-failed') {
        return {
          status: 'discovery-failed',
          source,
          reason: 'tool-discovery-failed',
          error: toolResult.error,
        };
      }

      toolPath = toolResult.path;
      const prefixResult = runCommand(toolPath, ['--prefix'], {
        env: brewEnvironment(env),
      });
      const prefix = prefixResult.status === 0 && !prefixResult.error && !prefixResult.signal
        ? prefixResult.stdout.trim()
        : '';
      if (!prefix) {
        return {
          status: 'discovery-failed',
          source,
          reason: 'prerequisite-command-failed',
          error: prefixResult.error,
          exitStatus: prefixResult.status,
          signal: prefixResult.signal,
        };
      }
      completionDirectory = path.join(prefix, ...backupScope.bashCompletions.path);
    }

    const source = {
      ...directorySource(completionDirectory),
      ...(toolPath ? { root: path.dirname(path.dirname(completionDirectory)) } : {}),
    };
    return sourceFromPathDiscovery(
      inspectPath(completionDirectory, 'directory'),
      source,
      {
        fileName: backupScope.bashCompletions.name,
        command: 'ls',
        args: [completionDirectory],
        env,
      },
    );
  },
});

const portableConfigSnapshot = (): SnapshotDefinition => {
  const definition = fileSnapshot(
    'ballin',
    'preferences',
    configSnapshotFileName,
    path.join(...backupScope.preferences.path),
  );
  return {
    ...definition,
    discover: (context) => {
      const result = definition.discover(context);
      if (result.status !== 'available') {
        return result;
      }
      return {
        ...result,
        collector: {
          ...result.collector,
          command: process.execPath,
          args: [path.join(__dirname, '..', 'config', 'portable.ts'), result.source.path as string],
        },
      };
    },
  };
};

const codexRoot = ({ homeDir, env }: SnapshotDiscoveryContext): string => (
  env[backupScope.roots.codexEnvironment] ? path.resolve(env[backupScope.roots.codexEnvironment]!) : path.join(homeDir, backupScope.roots.codex)
);

// Selected assistant configuration can contain executable and private content.
// Every source is sensitive; policy selection precedes discovery.
const configurationSnapshot = (category: 'codex' | 'claude', name: string, relative: string, recursive: boolean, profiles: boolean, homeRoot: boolean, skills: boolean): SnapshotDefinition => ({
  name,
  directory: recursive,
  category,
  inclusionGroup: 'sensitive',
  prerequisites: [{ kind: recursive ? 'directory' : 'file', name: relative }],
  discover: (context) => {
    const claude = category === 'claude';
    // Claude skills include personal folders and manifest-verified plugin-origin
    // synced packages. Manifest metadata selects packages without reading skills.
    const selection = claude ? { markdownOnly: !skills, claudeSkills: skills, rejectHardlinks: true } : {};
    const directoryMode = claude && skills ? 'claude-skills' : claude ? 'markdown' : profiles ? 'profiles' : skills ? 'skills' : 'directory';
    const logicalRoot = claude
      ? context.env[backupScope.roots.claudeEnvironment] ? path.resolve(context.env[backupScope.roots.claudeEnvironment]!) : path.join(context.homeDir, backupScope.roots.claude)
      : homeRoot ? context.homeDir : codexRoot(context);
    let root = logicalRoot;
    let sourcePath = path.join(root, relative);
    const source = recursive ? directorySource(sourcePath) : fileSource(sourcePath, root);
    try {
      root = fs.realpathSync(logicalRoot);
      sourcePath = require('./recursive_snapshot.ts').checkedPath(root, relative);
      // Unlike existing dotfiles, assistant sources never follow symlinked entries.
      const stat = require('./recursive_snapshot.ts').sourceStat(root, relative);
      if (stat.isSymbolicLink() || (recursive ? !stat.isDirectory() : !stat.isFile())) {
        return { status: 'unavailable', source, reason: 'unsupported-source-type' };
      }
      if (claude && stat.isFile() && stat.nlink !== 1) throw new Error('Hard-linked Claude source');
      if (recursive && require('./recursive_snapshot.ts').recursiveFiles(sourcePath, profiles, skills, {}, selection).length === 0) {
        return { status: 'absent', source, reason: 'source-not-found' };
      }
      return {
        status: 'available', source,
        collector: {
          fileName: name,
          command: process.execPath,
          args: recursive
            ? [path.join(__dirname, 'recursive_snapshot.ts'), sourcePath, directoryMode, ...(claude ? ['--reject-hardlinks'] : [])]
            : [path.join(__dirname, 'recursive_snapshot.ts'), root, 'file', relative, ...(claude ? ['--reject-hardlinks'] : [])],
          env: context.env,
        },
      };
    } catch (error) {
      // A failed cwd restoration is fatal; ordinary optional-source handling
      // must never continue discovery or publication from a different cwd.
      if (error instanceof require('./recursive_snapshot.ts').SnapshotCwdError) throw error;
      if (error instanceof require('./recursive_snapshot.ts').SnapshotLimitError) {
        return { status: 'discovery-failed', source, reason: 'source-limit-exceeded', error: error as Error };
      }
      if (errorCode(error) === 'ELOOP' || error instanceof require('./recursive_snapshot.ts').SnapshotSourceTypeError) {
        return { status: 'unavailable', source, reason: 'unsupported-source-type' };
      }
      return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR'
        ? { status: 'absent', source, reason: 'source-not-found' }
        : { status: 'discovery-failed', source, reason: 'source-access-failed', error: error as Error };
    }
  },
});

// The data catalog owns source and collection scope; capture internals stay here.
type SnapshotSpec =
  | ['file', ...Parameters<typeof fileSnapshot>]
  | ['command', category: SnapshotCategory, group: SnapshotInclusionGroup, name: string, tool: string, command: string]
  | ['editor-file', ...Parameters<typeof editorFileSnapshot>]
  | ['editor-extensions', ...Parameters<typeof editorExtensionsSnapshot>]
  | ['configuration', ...Parameters<typeof configurationSnapshot>]
  | ['bash-completions']
  | ['preferences'];
const snapshotDefinitions: readonly SnapshotDefinition[] = (backupScope.sources as SnapshotSpec[]).map((spec) => {
  switch (spec[0]) {
    case 'file': return fileSnapshot(...spec.slice(1) as Parameters<typeof fileSnapshot>);
    case 'command': {
      const [, category, group, name, tool, command] = spec;
      const environment = category === 'homebrew' ? brewEnvironment
        : name === 'pipx' ? (env: NodeJS.ProcessEnv) => ({ ...env, PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE: '1' }) : undefined;
      return shellCommandSnapshot(category, group, name, tool, command, {
        environment, suppressStderrOnSuccess: ['brew_services', 'pipx', 'uv_tools'].includes(name) || undefined,
      });
    }
    case 'editor-file': return editorFileSnapshot(...spec.slice(1) as Parameters<typeof editorFileSnapshot>);
    case 'editor-extensions': return editorExtensionsSnapshot(...spec.slice(1) as Parameters<typeof editorExtensionsSnapshot>);
    case 'configuration': return configurationSnapshot(...spec.slice(1) as Parameters<typeof configurationSnapshot>);
    case 'bash-completions': return bashCompletionsSnapshot();
    case 'preferences': return portableConfigSnapshot();
  }
});

const currentSnapshotFileNames = new Set(snapshotDefinitions.map(({ name }) => name));
const directorySnapshotFileNames = new Set(snapshotDefinitions.filter(({ directory }) => directory).map(({ name }) => name));
const configurationSnapshotGroups = new Map<string, 'codex' | 'claude'>(snapshotDefinitions.flatMap(({ name, category }) => (
  category === 'codex' || category === 'claude' ? [[name, category] as const] : []
)));

const isSnapshotSelected = (definition: SnapshotDefinition, includeSensitive: boolean): boolean => {
  switch (definition.inclusionGroup) {
    case 'inventory':
    case 'preferences':
      return true;
    case 'sensitive':
      return includeSensitive === true;
    default:
      return false;
  }
};

const observeSnapshotSources = (
  context: SnapshotDiscoveryContext,
  includeSensitive = false,
): SnapshotSourceObservation[] => {
  // CommonJS callers can bypass the TypeScript type. Reject invalid consent
  // before even baseline discovery starts.
  if (typeof includeSensitive !== 'boolean') {
    throw new TypeError('Invalid sensitive-source selection: expected a boolean.');
  }
  return snapshotDefinitions.map((definition) => ({
    definition,
    ...(isSnapshotSelected(definition, includeSensitive)
      ? definition.discover(context)
      : { status: 'excluded-by-policy' as const, reason: 'excluded-by-policy' as const }),
  }));
};

const collectSnapshotObservations = (
  observations: SnapshotSourceObservation[],
  capture: (source: AvailableSnapshotObservation) => SnapshotCaptureResult,
): SnapshotCollectionObservation[] => observations.map((source) => {
  if (source.status !== 'available') {
    return { status: 'skipped', source, reason: source.reason };
  }
  const result = capture(source);
  return result.status === 'captured'
    ? { status: 'captured', source, localFile: result.localFile }
    : { status: 'collector-failed', source };
});

const normalizeSnapshotInput = (inputFile: string, maxBytes?: number): void => {
  if (fs.statSync(inputFile).size === 0) {
    fs.writeFileSync(inputFile, emptySnapshotContent);
    return;
  }

  const content = maxBytes === undefined ? fs.readFileSync(inputFile)
    : require('./recursive_snapshot.ts').readBoundedFile(inputFile, maxBytes).bytes;
  if (content.at(-1) !== 10) {
    fs.appendFileSync(inputFile, '\n');
  }
};

const classifySnapshotFileName = (fileName: string): SnapshotNameClassification => {
  if (currentSnapshotFileNames.has(fileName)) {
    return 'current';
  }
  if (retiredSnapshotFileNames.has(fileName)) {
    return 'retired';
  }
  if (reservedSnapshotFileNames.has(fileName)) {
    return 'reserved';
  }
  return 'unexpected';
};

module.exports = {
  repositoryMarkerFileName,
  repositoryReadmeFileName,
  classifySnapshotFileName,
  configurationSnapshotGroups,
  directorySnapshotFileNames,
  collectSnapshotObservations,
  configSnapshotFileName,
  emptySnapshotContent,
  isSnapshotSelected,
  normalizeSnapshotInput,
  observeSnapshotSources,
  snapshotDefinitions,
};

export type {
  AvailableSnapshotObservation,
  SnapshotCaptureResult,
  SnapshotCategory,
  SnapshotCollectionObservation,
  SnapshotCommand,
  SnapshotDefinition,
  SnapshotDiscoveryContext,
  SnapshotInclusionGroup,
  SnapshotNameClassification,
  SnapshotPrerequisite,
  SnapshotSourceObservation,
};
