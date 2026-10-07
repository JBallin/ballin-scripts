const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createSandbox, cleanupSandbox, resetSandbox, sandboxEnvironment, recordSession, processIsAlive } = require('./helpers/onboarding.ts');
import type { Sandbox } from './helpers/onboarding.ts';
import type { ChildProcess } from 'child_process';

const { scenarios, activeScenario, selectScenario } = require('./helpers/sandbox_scenarios.ts');
const usage = 'Usage: npm run sandbox -- [--keep] [--scenario <name>] | --cleanup <sandbox-root>';
const write = (text: string): void => { process.stdout.write(text + '\n'); };
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const readLine = (): Promise<string | null> => new Promise((resolve, reject) => {
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  const read = (): void => {
    fs.read(0, byte, 0, 1, null, (error: Error | null, count: number) => {
      if (error) { reject(error); return; }
      if (!count) { resolve(null); return; }
      if (byte[0] === 10) { resolve(Buffer.from(bytes).toString('utf8').trim()); return; }
      if (byte[0] !== 13) bytes.push(byte[0]);
      read();
    });
  };
  read();
});
const inspectSandbox = (sandbox: Sandbox): void => {
  sandboxEnvironment(sandbox);
  for (const file of [path.join(sandbox.repo, 'ballin.config.json'), sandbox.log]) {
    write(`\n${file}\n${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(not created)'}`);
  }
  const state = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
  write(`\nFake repository: ${state.exists ? state.login + '/' + state.name : '(not created)'}`);
  if (state.exists) {
    for (const [name, contents] of Object.entries(state.commits[state.head].files)) {
      write(`\n${name}\n${Buffer.from(contents as string, 'base64').toString('utf8')}`);
    }
  }
  write(`\nCache: ${path.join(sandbox.repo, '.backup-cache')}\nFull fake state: ${path.join(sandbox.remote, 'repository.json')}`);
};
const runQa = async (args = process.argv.slice(2)): Promise<number> => {
  if (args[0] === '--cleanup' && args.length === 2) {
    cleanupSandbox(path.resolve(args[1]));
    write('Onboarding sandbox removed.');
    return 0;
  }
  const options = args.filter((arg) => arg !== '--keep');
  if (args.filter((arg) => arg === '--keep').length > 1 || (options.length && !(options.length === 2 && options[0] === '--scenario' && Object.hasOwn(scenarios, options[1])))) {
    write(usage);
    return 2;
  }
  const sandbox: Sandbox = createSandbox();
  const activePath = path.join(sandbox.root, '.active');
  const cleanupCommand = `npm run sandbox -- --cleanup ${shellQuote(sandbox.root)}`;
  const groups = new Set<number>();
  let launchPending = false;
  recordSession(sandbox, []);
  let preserve = args.includes('--keep');
  let interrupted = false;
  let child: ChildProcess | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const finishMarker = (): boolean => {
    const live = [...groups].filter((group) => processIsAlive(-group));
    if (launchPending || live.length) {
      recordSession(sandbox, live, launchPending);
      return true;
    }
    fs.rmSync(activePath, { force: true });
    return false;
  };
  const interrupt = (): void => {
    interrupted = true;
    preserve = true;
    if (child?.pid) {
      const pid = child.pid;
      try { process.kill(-pid, 'SIGINT'); } catch { /* The child may already have exited. */ }
      if (!killTimer) killTimer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* The group may already have exited. */ }
      }, 1000);
    } else {
      write(`\nInterrupted; preserved sandbox: ${sandbox.root}\nCleanup: ${cleanupCommand}`);
      finishMarker();
      process.exit(130);
    }
  };
  const launch = (commandArgs: string[]): Promise<number> => {
    const env = sandboxEnvironment(sandbox);
    const installer = commandArgs[0] === 'install';
    return new Promise((resolve, reject) => {
      launchPending = true;
      recordSession(sandbox, [...groups], true);
      const launched: ChildProcess = spawn(installer ? path.join(sandbox.source, 'install.sh') : path.join(sandbox.bin, 'ballin'),
        installer ? [] : commandArgs,
        { cwd: sandbox.home, env, stdio: 'inherit', detached: true });
      child = launched;
      if (launched.pid) {
        groups.add(launched.pid);
        launchPending = false;
        recordSession(sandbox, [...groups]);
      }
      launched.once('error', (error: Error) => {
        if (!launched.pid) {
          launchPending = false;
          recordSession(sandbox, [...groups]);
        }
        reject(error);
      });
      launched.once('close', (code: number | null, signal: string | null) => {
        if (interrupted && child?.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No remaining children. */ }
        }
        child = undefined;
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        if (launched.pid && processIsAlive(-launched.pid)) {
          preserve = true;
          interrupted = true;
          write('A sandbox child process group remains active; cleanup will refuse until it exits.');
        }
        resolve(signal ? 130 : code ?? 1);
      });
    });
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  write(`Ballin onboarding sandbox: ${sandbox.root}\nHOME: ${sandbox.home}\nInstalled checkout: ${sandbox.repo}\nFake repository: ${sandbox.remote}\nExternal services are blocked. Commands below run only in this sandbox.`);
  try {
    if (options.length) selectScenario(sandbox, options[1]);
    write(`Active scenario: ${activeScenario(sandbox)}`);
    if (await launch(['install'])) preserve = true;
    while (!interrupted) {
      write(`\nActive scenario: ${activeScenario(sandbox)}\nCommands: scenarios | scenario <name> | clear | install | ballin <arguments> | inspect | reset fresh | reset create | reset reconnect | keep | exit`);
      process.stdout.write('sandbox> ');
      const line = await readLine();
      if (line === null || line === 'exit') break;
      if (interrupted) break;
      if (line === 'keep') { preserve = true; write('Sandbox will be preserved.'); }
      else if (line === 'scenarios') { for (const [name, description] of Object.entries(scenarios)) write(`${name}: ${description}`); }
      else if (line === 'clear' || line.startsWith('scenario ')) {
        try { selectScenario(sandbox, line === 'clear' ? 'none' : line.slice(9)); write(`Active scenario: ${activeScenario(sandbox)}`); }
        catch (error) { write((error as Error).message); }
      }
      else if (line === 'inspect') inspectSandbox(sandbox);
      else if (['reset fresh', 'reset create', 'reset reconnect'].includes(line)) {
        resetSandbox(sandbox, line.split(' ')[1] as 'fresh' | 'create' | 'reconnect');
        write('Reset complete. Run install after reset fresh; otherwise run ballin backup setup.');
      } else if (line === 'install' || line.startsWith('ballin ')) {
        if (line.startsWith('ballin ') && !fs.existsSync(path.join(sandbox.bin, 'ballin'))) {
          sandboxEnvironment(sandbox);
          write('Ballin is not installed in this sandbox. Run install, then retry this command.');
          continue;
        }
        const status = await launch(line === 'install' ? ['install'] : line.split(/\s+/u).slice(1));
        if (status) { preserve = true; write(`Command exited ${status}; sandbox will be preserved.`); }
      } else if (line) write('Unknown sandbox command. Arguments are whitespace-separated; no shell expansion or quoting.');
    }
  } catch (error) {
    preserve = true;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (finishMarker()) preserve = true;
    if (preserve) write(`\nPreserved sandbox: ${sandbox.root}\nCleanup: ${cleanupCommand}`);
    else { cleanupSandbox(sandbox.root); write('\nOnboarding sandbox removed.'); }
  }
  return interrupted ? 130 : 0;
};

if (require.main === module) {
  void runQa().then((status) => { process.exitCode = status; }).catch((error: Error) => {
    process.stderr.write(error.message + '\n'); process.exitCode = 1;
  });
}
module.exports = { runQa };
