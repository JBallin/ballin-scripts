const fs = require('fs');
const path = require('path');
import type { Sandbox } from './onboarding.ts';

const scenarios = {
  none: 'No controlled fault',
  auth: 'GitHub authentication rejected',
  connection: 'GitHub connection failure',
  timeout: 'GitHub request timeout',
  permission: 'Backup publication permission denied',
  ambiguous: 'Backup write succeeds but its response is lost',
  readback: 'Backup write succeeds but readback differs',
  conflict: 'Local and remote zshrc diverge from a confirmed baseline',
  'self-update': 'Git fetch fails during self-update',
  'update-failure': 'macOS update stage fails; later stages continue',
  'update-interrupt': 'macOS update stage waits after announcing readiness',
};
type Scenario = keyof typeof scenarios;
const scenarioPath = (sandbox: Sandbox): string => path.join(sandbox.root, 'scenario.json');
const activeScenario = (sandbox: Sandbox): Scenario => {
  const file = scenarioPath(sandbox);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Sandbox scenario state was replaced');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Object.hasOwn(scenarios, value.name) || Object.keys(value).join(',') !== 'name') throw new Error('Invalid sandbox scenario');
  return value.name;
};
const selectScenario = (sandbox: Sandbox, name: string): void => {
  const { validateSandbox } = require('./onboarding.ts');
  validateSandbox(sandbox);
  if (!Object.hasOwn(scenarios, name)) throw new Error('Unknown sandbox scenario; use scenarios to list choices');
  const file = path.join(sandbox.remote, 'repository.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (name === 'conflict') {
    const { repositoryCacheDirectory } = require('../../commands/backup_cache.ts');
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    const cache = path.join(repositoryCacheDirectory(path.join(sandbox.repo, '.backup-cache'), config.backup.repository), 'zshrc.sh');
    const local = path.join(sandbox.home, '.zshrc');
    const baseline = fs.readFileSync(cache, 'utf8');
    if (fs.lstatSync(local).isSymbolicLink() || fs.readFileSync(local, 'utf8') !== baseline
      || Buffer.from(state.commits[state.head].files['zshrc.sh'] ?? '', 'base64').toString() !== baseline) {
      throw new Error('Conflict scenario requires a successful zshrc backup with matching local, cache, and remote bytes');
    }
    const { commitFixture } = require('./repository.ts');
    commitFixture(state, { ...state.commits[state.head].files, 'zshrc.sh': Buffer.from(baseline + '# Remote scenario change\n').toString('base64') });
    fs.appendFileSync(local, '# Local scenario change\n');
  }
  state.faults = {};
  if (name === 'auth') state.faults.auth = true;
  if (name === 'connection' || name === 'timeout') state.faults.transport = {
    target: '', response: { status: 1, stdout: '', stderr: name === 'timeout' ? 'request timed out' : 'error connecting to api.github.com', signal: null },
  };
  if (name === 'permission') state.faults.publish = 'denied';
  if (name === 'ambiguous') state.faults.publish = 'ambiguous';
  if (name === 'readback') state.faults.publish = 'wrong-readback';
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(scenarioPath(sandbox), JSON.stringify({ name }));
  fs.rmSync(path.join(sandbox.root, 'update-stage.ready'), { force: true });
};
module.exports = { scenarios, scenarioPath, activeScenario, selectScenario };
export type { Scenario };
