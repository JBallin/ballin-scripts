#!/usr/bin/env python3
"""Build a local review gallery; never execute product/install commands."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent
LEGACY = TOOLS.parent / 'pr-662-output-gallery'
SGR = re.compile(r'\x1b\[[0-9;]*m')
CATEGORIES = ('Install & Quickstart', 'Setup & Backup', 'Update', 'Diagnostics')
STAGED_TOPICS = [
    ('Diagnostics', 'Gallery overview'),
    ('Install & Quickstart', 'Lean Node.js decisions'),
    ('Install & Quickstart', 'Quickstart installation'),
    ('Setup & Backup', 'General preferences and analytics'),
    ('Setup & Backup', 'Backup creation'),
    ('Setup & Backup', 'Backup reconnect and protection'),
    ('Setup & Backup', 'Context-sensitive follow-ups'),
    ('Setup & Backup', 'Cancellation and saved choices'),
    ('Setup & Backup', 'Invalid answers and shell setup'),
    ('Update', 'Revision transitions, errors and recovery'),
    ('Diagnostics', 'Doctor and help'),
]


def markdown_text(value):
    text = html.escape(str(value)).replace('\n', ' ')
    return re.sub(r'([\\`*_[\]])', r'\\\1', text)


def edit_disclosure(entry):
    edits = entry.get('edits', 'No edit declaration supplied.')
    if not isinstance(edits, dict):
        return str(edits)
    summary = str(edits.get('method', 'See provenance for edit details.'))
    counts = edits.get('counts')
    omitted = edits.get('omitted') or (counts.get('omitted') if isinstance(counts, dict) else None)
    if omitted:
        summary += ' Omitted: ' + ('; '.join(omitted) if isinstance(omitted, list) else str(omitted))
    return summary


def staged_case_ranges(text):
    """Keep current staged case notes and outcomes together, including blanks."""
    lines = text.split('\n')
    if lines[-1] == '':
        lines.pop()
    if not lines:
        return []
    starts = [0] + [index for index, line in enumerate(lines) if index and line.startswith('[STAGED ')
                    and not line.startswith(('[STAGED omission', '[STAGED omitted'))]
    ranges = []
    for start, end in zip(starts, starts[1:] + [len(lines)]):
        if ranges and all(not line.strip() or line.startswith('[STAGED ') for line in lines[ranges[-1][0]:start]):
            ranges[-1][1] = end
        else:
            ranges.append([start, end])
    return ranges


def write_index(work, entries, source):
    lines = ['# Local output gallery', '', 'Source: `' + source + '`', '',
             'Each entry links the same content as Terminal ANSI, accessible text and rendered PNGs.',
             'Actual recordings and staged examples remain labeled separately.',
             'Each entry links its provenance. Staged excerpts retain inline omission notes; actual recordings disclose normalization/omissions below.', '']
    for category in CATEGORIES:
        lines += ['## ' + category, '']
        for entry in entries:
            if entry['category'] != category:
                continue
            folder = work / entry['id']
            links = [f'[ANSI]({entry["id"]}/preview.ansi)', f'[text]({entry["id"]}/text.txt)',
                     f'[provenance]({entry["id"]}/provenance.json)']
            links += [f'[PNG {index}]({entry["id"]}/{png.name})' for index, png in enumerate(sorted(folder.glob('output-*.png')), 1)]
            lines += [f'- {markdown_text(entry["title"])} ({entry["kind"]}): ' + ' · '.join(links)]
            if entry['kind'] == 'actual-vm':
                lines += ['  Normalization/omissions: ' + markdown_text(edit_disclosure(entry))]
        if not any(entry['category'] == category for entry in entries):
            lines += ['No entries recorded yet.']
        lines += ['']
    (work / 'index.md').write_text('\n'.join(lines))


def run(command, **kwargs):
    return subprocess.run(command, check=True, timeout=120, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plain_text(ansi):
    text = SGR.sub('', ansi.replace('\r\n', '\n'))
    if any((ord(char) < 32 and char != '\n') or 127 <= ord(char) <= 159 for char in text):
        raise ValueError('Unsupported terminal controls: retain the raw capture and normalize explicitly before import')
    return text


def update_example(staged, sample):
    """Reuse #667's static styling with the gallery's reviewed pure formatter."""
    text = plain_text(sample.read_text())
    if not text.startswith('$ ballin update\n'):
        raise ValueError('Update example must start with its illustrative command')
    trusted = json.loads((LEGACY / 'generation-runtime.json').read_text())
    if digest(staged / 'terminalStyle.ts') != trusted['executableHashes']['terminalStyle.ts']:
        raise ValueError('Unreviewed gallery runtime: terminalStyle.ts')
    source = (staged / 'source-evidence/commands/update.ts').read_text()
    headings = [line[4:] for line in text.splitlines() if line.startswith('==> ')]
    # Homebrew supplies its own first heading; all Ballin phase labels/order must
    # match the immutable product snapshot rather than an invented successful run.
    if not headings or headings[0] != 'Updating Homebrew...' or "runIntegrationCommand('brew', ['update']" not in source:
        raise ValueError('Review Homebrew update example against product source')
    positions = [source.index("progress('" + heading + "')") for heading in headings[1:]]
    if positions != sorted(positions):
        raise ValueError('Update example phase order differs from product source')
    script = r"""
const fs = require('node:fs');
const t = require(process.argv[1]);
const env = { TERM: 'xterm-256color' }, stream = { isTTY: true };
const lines = fs.readFileSync(0, 'utf8').trimEnd().split('\n').map(line => {
  if (line.startsWith('$ ')) return t.terminalEmphasis(line, 'bold', stream, env);
  if (line.startsWith('==> ')) return t.terminalHeading(line.slice(4), stream, env);
  if (line.startsWith('✓ ')) return '\x1b[0;32m✓\x1b[0m ' + line.slice(2);
  const changed = line.match(/^([+~-]) (.+)$/u);
  return changed ? changed[1] + ' ' + t.terminalEmphasis(changed[2], 'bold', stream, env) : line;
});
process.stdout.write(lines.join('\n') + '\n');
"""
    return subprocess.check_output(['node', '-e', script, str((staged / 'terminalStyle.ts').resolve())],
                                   input=text.encode(), timeout=15).decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Full immutable product commit SHA available locally')
    parser.add_argument('--output', type=Path, help='New local output directory (default: ignored .output-gallery/<source>)')
    parser.add_argument('--captures', type=Path, help='Optional reviewed VM capture manifest; see README')
    parser.add_argument('--readme-example-only', action='store_true', help='Render only the canonical staged Update illustration')
    args = parser.parse_args()
    if args.readme_example_only and args.captures:
        parser.error('--readme-example-only does not import VM captures')
    if not re.fullmatch('[0-9a-f]{40}', args.source):
        parser.error('--source must be a full immutable commit SHA')
    resolved = subprocess.check_output(['git', 'rev-parse', args.source + '^{commit}'], cwd=ROOT, text=True).strip()
    if resolved != args.source:
        parser.error('Source revision did not resolve exactly')
    output = (args.output or ROOT / '.output-gallery' / args.source).resolve()
    if output.exists():
        parser.error('Output already exists; choose a new directory to preserve previous evidence')
    # Generated artifacts cannot accidentally enter the source tree unignored.
    if output.is_relative_to(ROOT):
        ignored = subprocess.run(['git', 'check-ignore', '--no-index', '-q', str(output / 'probe')], cwd=ROOT)
        if ignored.returncode != 0:
            parser.error('Output inside the checkout must be Git-ignored')
    if subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip() != '26':
        parser.error('Use Node.js 26 from .nvmrc')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Retain failed builds for diagnosis, clearly separate from successful output.
    work = Path(tempfile.mkdtemp(prefix='.gallery-build-', dir=output.parent))
    for name in ['run.py', 'render.swift', 'README.md', 'update-example.txt']:
        shutil.copy2(TOOLS / name, work / name)
    for name in ['build.py', 'verify.py', 'generation-runtime.json']:
        shutil.copy2(LEGACY / name, work / name)
    staged = work / 'staged'
    staged.mkdir()
    shutil.copy2(work / 'verify.py', staged)
    entries = []
    if args.readme_example_only:
        # Read candidate source as data. update_example checks the formatter
        # against the independently reviewed runtime pin before loading it.
        for name in ['commands/terminalStyle.ts', 'commands/update.ts']:
            data = subprocess.check_output(['git', 'show', args.source + ':' + name], cwd=ROOT)
            target = staged / ('terminalStyle.ts' if name.endswith('terminalStyle.ts') else 'source-evidence/' + name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    else:
        run(['python3', str(work / 'build.py'), '--root', str(ROOT), '--output', str(staged), '--candidate', args.source])
        run(['python3', str(staged / 'verify.py')], stdout=subprocess.PIPE)
        # Each preserved scenario is its own readable group; full raw captures remain intact.
        ansi = (staged / 'terminal-preview.ansi').read_text()
        sections = re.split(r'(?=\n==========================================================================\n)', ansi)
        if len(sections) != len(STAGED_TOPICS):
            raise ValueError('Review gallery index topics after changing staged sections')
        for index, section in enumerate(sections):
            entries.append({'id': f'staged-{index:02}', 'kind': 'staged', 'ansi': section,
                            'category': STAGED_TOPICS[index][0], 'title': STAGED_TOPICS[index][1],
                            'sourceRevision': args.source, 'edits': 'Source-informed synthetic prompts, answers and outcomes; inline labels disclose selected excerpts/omissions. No live execution.'})
    entries.append({'id': 'staged-update-example', 'kind': 'staged', 'category': 'Update',
                    'title': 'Routine Update — condensed illustration', 'sourceRevision': args.source,
                    'ansi': update_example(staged, work / 'update-example.txt'),
                    'edits': 'Condensed illustrative fully configured run, not a live recording. Ellipses replace upstream output; backup time, file states and destination are synthetic. Optional tools/preferences determine actual stages.'})
    capture_manifest = None
    if args.captures:
        capture_manifest = json.loads(args.captures.read_text())
        for capture in capture_manifest['captures']:
            # Identifiers become file names; all inputs are data, never shell commands.
            if not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}', capture['id']):
                parser.error('Invalid capture id')
            if capture['sourceRevision'] != args.source or capture['kind'] != 'actual-vm':
                parser.error('VM capture must identify this exact source revision and actual-vm kind')
            for key in ['command', 'answers', 'result', 'environment', 'rawSha256', 'edits', 'sensitiveDataReviewed']:
                if key not in capture:
                    parser.error('Missing capture provenance: ' + key)
            if capture['sensitiveDataReviewed'] is not True:
                parser.error('Review capture for sensitive data before importing')
            if capture.get('category', 'Diagnostics') not in CATEGORIES:
                parser.error('Unknown capture category; see README')
            title = capture.get('title', capture['id'])
            if not isinstance(title, str) or not 0 < len(title) <= 160 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in title):
                parser.error('Capture title must be short single-line text')
            source = (args.captures.resolve().parent / capture['raw']).resolve()
            if digest(source) != capture['rawSha256']:
                parser.error('Raw capture hash mismatch')
            text = source.read_bytes().decode('utf-8')
            plain_text(text)  # Reject unsupported controls before retaining anything.
            if any(e['id'] == capture['id'] for e in entries):
                parser.error('Duplicate capture id')
            entries.append({**capture, 'category': capture.get('category', 'Diagnostics'),
                            'title': capture.get('title', capture['id']), 'ansi': text})
    renderer = work / 'render'
    run(['swiftc', '-module-cache-path', str(work / 'swift-cache'), str(work / 'render.swift'), '-o', str(renderer)])
    for entry in entries:
        folder = work / entry['id']
        folder.mkdir()
        original = entry.pop('ansi')
        canonical = original.replace('\r\n', '\n')
        text = plain_text(canonical)
        label = ('STAGED — source-informed synthetic output; no live execution.' if entry['kind'] == 'staged'
                 else 'ACTUAL VM CAPTURE — rendered recorded output; not a Terminal screenshot.')
        header = label + '\nSource: ' + args.source + '\n\n'
        (folder / 'raw.ansi').write_bytes(original.encode('utf-8'))
        (folder / 'preview.ansi').write_text(header + canonical)
        (folder / 'text.txt').write_text(header + text)
        presentation = {'label': label, 'source': args.source, 'scenario': entry['title'] + ' (' + entry['id'] + ')',
                        'keepTogether': staged_case_ranges(text) if entry['id'] == 'staged-09' else []}
        if entry['kind'] == 'actual-vm' and entry.get('commandCaptionReviewed') is True and entry.get('command'):
            presentation['captionCommand'] = entry['command']
        (folder / 'presentation.json').write_text(json.dumps(presentation, indent=2) + '\n')
        run([str(renderer), str(folder / 'output'), str(folder / 'presentation.json')], input=(header + canonical).encode())
        render_report = json.loads((folder / 'output.json').read_text())
        if render_report['text'] != header + text:
            raise ValueError('Renderer/text fidelity mismatch: ' + entry['id'])
        entry['files'] = {file.name: digest(file) for file in folder.iterdir()}
        (folder / 'provenance.json').write_text(json.dumps(entry, indent=2) + '\n')
    write_index(work, entries, args.source)
    # Retain exact generation inputs; regenerate from the repository layout.
    if args.captures:
        (work / 'capture-input.json').write_text(json.dumps({'captures': [{**e, 'raw': e['id'] + '/raw.ansi'} for e in entries if e['kind'] == 'actual-vm']}, indent=2) + '\n')
    tool_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    manifest = {'sourceRevision': args.source, 'toolCheckoutHead': tool_head,
                'toolFiles': {name: digest(work / name) for name in ['run.py', 'render.swift', 'update-example.txt', 'build.py', 'verify.py', 'generation-runtime.json']},
                'toolWorktreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
                'preservedToolingRevision': 'c2f09af4636cc394adfc69666c6749ed5f91b9bf',
                'rendererPrecedentRevision': '64d48dca63fc8833c366539a487d615dbda45d3f',
                'dependencies': {name: subprocess.check_output(command, text=True).strip() for name, command in {
                    'node': ['node', '--version'], 'python': ['python3', '--version'],
                    'swift': ['swift', '--version'], 'macOS': ['sw_vers', '-productVersion']}.items()},
                'scenarios': entries,
                'coverage': 'Staged current-stack review only unless individual actual-vm entries exist. Presentation checks are not end-to-end evidence.',
                'regenerate': f'python3 tools/output-gallery/run.py --source {args.source}' + (' --captures /path/to/reviewed/manifest.json' if args.captures else '') + (' --readme-example-only' if args.readme_example_only else ''),
                'capturesManifest': capture_manifest,
                'vmCoverage': {'directInstallation': 'pending unless an actual-vm entry records it',
                               'quickstartWithoutHomebrew': 'pending unless an actual-vm entry records it',
                               'coreJourneys': 'pending unless actual-vm entries record them'}}
    (work / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # Drop compiler cache/binary from retained evidence; renderer source remains.
    shutil.rmtree(work / 'swift-cache')
    renderer.unlink()
    work.rename(output)
    print('Gallery: ' + str(output))
    print('Grouped index: ' + str(output / 'index.md'))
    print('Terminal preview: cat ' + str(output / ('staged-update-example' if args.readme_example_only else 'staged-02') / 'preview.ansi'))
    print('All images, matching text and provenance: ' + str(output / 'manifest.json'))


if __name__ == '__main__':
    main()
