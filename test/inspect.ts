// Standalone, read-only manual test helper. No Ballin imports or network calls.
// Usage: node test/inspect.ts [expected-repository-name] [checkout]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Only runtime/lookup paths cross the Git boundary: no inherited Git control,
// config injection, trace destinations, loader options, or credential variables.
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR']
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
  // Trace2 can also be enabled by on-disk config; environment values take precedence.
  GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0',
});
const commandOutput = (command: string, args: string[], env = process.env): string | null => {
  const result = spawnSync(command, args, {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  return result.status === 0 && !result.error ? result.stdout : null;
};
const version = (command: string, pattern: RegExp): string => (
  commandOutput(command, ['--version'], command === 'git' ? gitEnvironment() : process.env)?.match(pattern)?.[1] ?? 'unavailable'
);
const booleanSetting = (value: unknown): string => (
  value === true || value === 'true' ? 'true'
    : value === false || value === 'false' ? 'false' : value === undefined ? 'unset' : 'invalid'
);
const inspectConfig = (checkout: string, expectedName?: string): Record<string, unknown> => {
  const file = path.join(checkout, 'ballin.config.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1048576) return { state: 'unreadable' };
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { state: 'invalid' };
    const repository = config.backup?.repository;
    const hasText = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
    return {
      state: 'read',
      linkagePresent: repository !== undefined && repository !== null,
      nameMatchesExpected: expectedName === undefined ? null : repository?.name === expectedName,
      repositoryIdPresent: hasText(repository?.id),
      ownerIdPresent: hasText(repository?.ownerId),
      branchIsMain: repository?.branch === 'main',
      legacyGistPresent: hasText(config.backup?.id),
      includeSensitive: booleanSetting(config.backup?.includeSensitive),
      automaticBackup: booleanSetting(config.update?.backup),
    };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
};

const inspect = (): void => {
  const [, , expectedName, root, ...extra] = process.argv;
  if (extra.length || (expectedName !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/u.test(expectedName))) {
    process.stderr.write('Usage: node inspect.ts [expected-repository-name] [checkout]\n');
    process.exitCode = 2;
    return;
  }
  const checkout = path.resolve(root ?? path.join(os.homedir(), '.ballin-scripts'));
  const git = (args: string[]) => commandOutput('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', checkout, ...args,
  ], gitEnvironment());
  // Reject parent-repository discovery or core.worktree redirection instead of
  // silently reporting metadata for a different checkout. realpath handles /tmp on macOS.
  const top = git(['rev-parse', '--show-toplevel']);
  let selectedCheckout = false;
  try { selectedCheckout = top !== null && fs.realpathSync(top.trim()) === fs.realpathSync(checkout); } catch { /* unavailable */ }
  const head = selectedCheckout ? git(['rev-parse', '--verify', 'HEAD']) : null;
  // Status can execute clean/process filters. Inspect names only (never values),
  // including global and included config, and decline rather than disabling a
  // filter and misrepresenting the working tree's normal clean/dirty semantics.
  const keys = selectedCheckout ? git(['config', '--null', '--name-only', '--list', '--includes']) : null;
  const filtered = keys !== null && keys.split('\0').some((key: string) => /^filter\..*\.(?:clean|process)$/isu.test(key));
  const status = keys !== null && !filtered
    ? git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all']) : null;
  const macOS = process.platform === 'darwin'
    ? commandOutput('sw_vers', ['-productVersion'])?.trim().match(/^\d+\.\d+(?:\.\d+)?$/u)?.[0] ?? 'unavailable'
    : null;
  process.stdout.write(JSON.stringify({
    runtime: {
      platform: process.platform, arch: process.arch, macOS, node: process.versions.node,
      npm: version('npm', /^(\d+\.\d+\.\d+)\s*$/u),
      git: version('git', /^git version (\d+\.\d+\.\d+)(?:\s|$)/u),
      gh: version('gh', /^gh version (\d+\.\d+\.\d+)(?:\s|$)/u),
    },
    installedCommit: head?.trim().match(/^[a-f0-9]{40}$/u)?.[0] ?? 'unavailable',
    workingTree: status === null ? 'unavailable' : status.length ? 'dirty' : 'clean',
    workingTreeReason: !selectedCheckout ? 'checkout-unavailable' : keys === null ? 'config-unavailable'
      : filtered ? 'filters-configured' : status === null ? 'status-failed' : null,
    backup: inspectConfig(checkout, expectedName),
  }, null, 2) + '\n');
};

if (require.main === module) inspect();
