#!/usr/bin/env python3
"""Bounded display verification. Launches only the standalone gallery renderer."""
import errno,fcntl,hashlib,json,os,pathlib,pty,re,select,shutil,struct,subprocess,termios,time
ROOT=pathlib.Path(__file__).resolve().parent
NODE=shutil.which('node')
if NODE is None:raise SystemExit('Node.js 26 must be available on PATH')
# Check reviewed executable bytes before the first child process, including direct replay.
trusted=json.loads((ROOT/'trusted-runtime.json').read_text())
for file,expected in trusted['executableHashes'].items():
 if hashlib.sha256((ROOT/file).read_bytes()).hexdigest()!=expected:raise SystemExit('Unreviewed gallery runtime: '+file)
command=[NODE,str(ROOT/'gallery.cjs')]
env={'PATH':os.environ.get('PATH',os.defpath),'TERM':'xterm','LANG':'en_US.UTF-8'}
def capture(name,changes=None,tty=False):
 e={**env,**(changes or {})}
 if tty:
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
  proc=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=slave,stderr=slave,env=e);os.close(slave)
  chunks=[];deadline=time.monotonic()+15
  try:
   while True:
    remaining=deadline-time.monotonic()
    if remaining<=0 or not select.select([master],[],[],max(0,remaining))[0]:
     raise TimeoutError('Staged renderer PTY capture exceeded 15 seconds')
    try:
     block=os.read(master,65536)
     if not block:break
     chunks.append(block)
    except OSError as error:
     if error.errno!=errno.EIO:raise
     break
   code=proc.wait(timeout=max(0.01,deadline-time.monotonic()));output=b''.join(chunks)
  finally:
   os.close(master)
   if proc.poll() is None:proc.kill()
   proc.wait()

 else:
  result=subprocess.run(command,env=e,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
  assert not result.stderr,result.stderr;code=result.returncode;output=result.stdout
 assert code==0,(name,code,output[-1000:])
 (ROOT/name).write_bytes(output)
 return output.decode().replace('\r\n','\n')
plain=capture('plain.txt');normal=capture('terminal-preview.ansi',tty=True)
no_color=capture('no-color-pty.txt',{'NO_COLOR':'1'},True)
dumb=capture('dumb-pty.txt',{'TERM':'dumb'},True)
strip=lambda text:re.sub(r'\x1b\[[0-9;]*m','',text)
canonical=lambda text:re.sub(r'\s+',' ',strip(text).replace('`','')).strip()
assert canonical(normal)==canonical(plain)
assert normal.count('\n\n')==plain.count('\n\n')
assert no_color==plain and dumb==plain
assert '\x1b[' not in plain+no_color+dumb
url='https://github.com/example-user/synthetic-ballin-backup'
assert '\nProposed backup: '+url+'\n' in normal
assert '\nProposed backup: \x1b[34m'+url+'\x1b[0m\n' in normal
assert 'Private backup created: \x1b[34m'+url+'\x1b[0m' in normal
assert '[CREATE/reconnect] \x1b[36mCreate\x1b[0m' in normal
assert '[login/bashrc; Enter to skip] \x1b[36mSkip\x1b[0m' in normal
for word in ['Y','N','CREATE','NONE']:assert '\x1b[1m'+word+'\x1b[0m' not in normal
assert normal.count('==========================================================================')==10
assert plain.endswith('The process exits normally. When run in an existing Terminal, output stays in scrollback.\n')
assert 'NVM can install and maintain' not in plain
assert 'Optional tab completion suggests' not in plain
assert 'Please enter yes or no' not in plain
assert 'confirmed local preferences remain saved' not in plain
assert 'Enter Yes or No.' in plain and 'Enter Create or Reconnect.' in plain
assert 'Backups may contain private information or secrets.' in plain
assert 'See Reconnect details above.' in canonical(plain) and 'See Backup details above.' in canonical(plain)
followups=plain.split('6. Context-sensitive follow-ups')[1].split('7. Truthful cancellation')[0]
initial=followups.split('[STAGED alternative')[0]
assert initial.count('Change backup settings later with')==1
assert 'Run `ballin backup setup` when' not in initial
assert initial.index('Change backup settings later')<initial.index('Change preferences later')
standalone_backup=followups.split('standalone backup success: related flow only')[1].split('[STAGED alternative')[0]
assert 'Change backup settings later' not in standalone_backup
standalone_general=followups.split('standalone general success: related flow only')[1]
assert 'Change preferences later' not in standalone_general
config='Configuration file: "/synthetic-home/custom Ballin settings/projects/isolated-fixture/configuration/ballin.config.json"'
for output in [plain,normal,no_color,dumb]:
 assert output.splitlines().count(config)==4
 assert 'EACCES: permission denied.' in output
 assert 'ENOSPC: no space left on the filesystem.' in output
 assert '`update.cleanup`, `update.npm`' in output
 assert 'NVM LTS installation did not finish' not in output
 assert 'Node.js LTS installation did not finish.' in canonical(output)
 assert 'NVM installation did not finish.' in canonical(output)
 assert 'Update Node.js LTS through NVM?' in output
 assert 'Keep NVM-managed Node on latest LTS?' not in output
 assert 'Ballin self-update requires confirmation.' not in output
 assert 'Confirmation required. Run' in output
 assert 'commit aaaaaaaaaaaa' in output and 'branch main (bbbbbbbbbbbb)' in output
 assert 'Ballin revision identity updated: branch main (aaaaaaaaaaaa) to commit aaaaaaaaaaaa.' in output
 assert 'Ballin updated: v2.0.0 to v1.2.3 (0 new commits).' in output
 assert 'development aaaaaaaaaaaa (dirty)' in output
 assert 'unknown revision' in output
 assert 'a'*40 not in output and 'b'*40 not in output
assert 'Confirmation required. Run \x1b[1mballin self-update\x1b[0m manually to continue.' in normal
assert 'Confirmation required. Run `ballin self-update` manually to continue.' in plain
main=plain.split('2. Coherent Quickstart installation')[1].split('3. General preferences and analytics')[0]
expected_questions=['Set up backups to GitHub? [Y/n] No','Use NVM with Node.js LTS instead? [y/N] Yes','Proceed with installation? [y/N] Yes','Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] login','Add Ballin setup to ~/.bash_profile so it works in new Terminal windows? [y/N] Yes','Enable Ballin tab completion? [y/N] Yes','Review your Ballin preferences? [Y/n] Yes','Update global npm packages? [y/N] No','Update Ballin? [Y/n] Yes','Clean up Homebrew? [Y/n] Yes','Update macOS? [Y/n] No','Update Node.js LTS through NVM? [Y/n] Yes','Share usage analytics to help improve Ballin? [y/N] No']
positions=[main.index('? '+question) for question in expected_questions]
assert positions==sorted(positions)
assert sum(line.startswith('? ') for line in main.splitlines())==len(expected_questions)
assert main.count('Setup complete.')==1
assert main.index('Change preferences later with')<main.index('to configure or review your GitHub backup.')<main.index('✓ Setup complete.')
assert 'complete standalone review prompts' in plain
assert 'standalone backup preference review cancelled after a saved answer' not in plain
for file in ['gallery.cjs','terminalStyle.ts','help_format.ts','doctor_report.ts','diagnostics.ts','selection_label.cjs']:
 text=(ROOT/file).read_text()
 for forbidden in ["require('child_process')","require('node:child_process')","require('http')","require('https')","fetch(",'writeFile','appendFile','unlink','mkdir','spawn(','execSync(','cp.exec(']:
  assert forbidden not in text,(file,forbidden)
 assert 'process.stdin' not in text
report={'candidate':json.loads((ROOT/'provenance.json').read_text())['candidateHead'],'exit_codes':{'plain':0,'normal_pty':0,'NO_COLOR_pty':0,'dumb_pty':0},'checks':['10 labeled selected sections','PTY/plain words agree allowing command backticks and normal wrapping; paragraph counts agree','NO_COLOR/dumb output has no ANSI','plain proposed Create; blue successful Create and existing Reconnect','neutral uppercase defaults; cyan canonical labels including Skip','current retry/cancellation/privacy copy','raw quoted synthetic configuration paths; whitelisted filesystem causes','literal missing keys remain backticked in every mode','source-derived selection labels and staged proposal/summary identities','current Node.js preference/help and component-specific failures','all 13 applicable main-flow fixed-choice prompts present in source order; excerpts identify omissions','pure formatter/runtime import review; no child/network/input/mutating calls in renderer'],'limits':['Selected staged excerpts, not a live transcript','No product/VM actions','No verification of interactive redraw or product execution by this static renderer','Immutable candidate recorded in provenance.json' if json.loads((ROOT/'provenance.json').read_text())['candidateHead'] else 'Draft source identified by sourceSnapshotHash'],'captures':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['plain.txt','terminal-preview.ansi','no-color-pty.txt','dumb-pty.txt']}}
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
