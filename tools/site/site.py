#!/usr/bin/env python3
"""Build complete documentation snapshots and curate public gallery bundles."""
import argparse
import hashlib
import html
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
REPO = 'JBallin/ballin-scripts'
API = 'https://api.github.com/repos/' + REPO
CATEGORIES = ('Install & Quickstart', 'Setup & Backup', 'Update', 'Diagnostics')
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_ZIP = 40 * 1024 * 1024
SHA = re.compile(r'[0-9a-f]{64}')
REV = re.compile(r'[0-9a-f]{40}')
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def load_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def keys(value, names, optional=''):
    required = set(names.split())
    require(isinstance(value, dict) and required <= set(value) <= required | set(optional.split()),
            'Unexpected or missing schema fields')


def string(value, limit=1000):
    require(isinstance(value, str) and 0 < len(value) <= limit, 'Invalid display string')
    require(not any(ord(c) < 32 and c != '\n' for c in value), 'Control characters in display text')
    return value


def valid_path(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9/-]+(?:\.[a-z0-9]+)?', value), 'Unexpected archive path')
    require(not value.startswith('/') and all(p not in ('', '.', '..') for p in value.split('/')), 'Unsafe archive path')
    return value


def validate_png(data):
    require(data.startswith(b'\x89PNG\r\n\x1a\n'), 'Invalid PNG signature')
    offset, chunks, compressed = 8, [], bytearray()
    width = height = depth = color = 0
    while offset < len(data):
        require(offset + 12 <= len(data), 'Truncated PNG chunk')
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + length + 12
        require(end <= len(data), 'Truncated PNG payload')
        body = data[offset + 8:end - 4]
        require(zlib.crc32(kind + body) == struct.unpack('>I', data[end - 4:end])[0], 'PNG checksum mismatch')
        # AppKit's ordinary image/profile chunks are supported. Text and arbitrary
        # ancillary payloads are deliberately outside the publication allowlist.
        require(kind in (b'IHDR', b'PLTE', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'cHRM', b'pHYs', b'iCCP', b'tRNS', b'sBIT'), 'Unexpected PNG chunk')
        if not chunks:
            require(kind == b'IHDR' and length == 13, 'Invalid PNG header')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', body)
            allowed = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            require(color in allowed and depth in allowed[color] and compression == filtering == interlace == 0, 'Unsupported PNG encoding')
            require(0 < width <= 10000 and 0 < height <= 20000, 'Oversize PNG dimensions')
        else:
            require(kind != b'IHDR', 'Duplicate PNG header')
        if kind == b'IDAT':
            require(b'IEND' not in chunks and (b'IDAT' not in chunks or chunks[-1] == b'IDAT'), 'Nonconsecutive PNG image chunks')
            compressed.extend(body)
        if kind == b'IEND':
            require(length == 0 and end == len(data), 'Invalid PNG ending')
        chunks.append(kind)
        offset = end
    require(chunks and chunks[-1] == b'IEND' and compressed, 'Incomplete PNG')
    if color == 3:
        require(b'PLTE' in chunks and chunks.index(b'PLTE') < chunks.index(b'IDAT'), 'Missing PNG palette')
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    stride = (width * depth * channels + 7) // 8 + 1
    expanded = stride * height
    require(expanded <= 64 * 1024 * 1024, 'Oversize decoded PNG')
    decoder = zlib.decompressobj()
    try:
        pixels = decoder.decompress(compressed, expanded + 1)
    except zlib.error as error:
        raise ValueError('Invalid PNG image stream') from error
    require(len(pixels) == expanded and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, 'PNG image size/stream mismatch')
    require(all(pixels[row * stride] <= 4 for row in range(height)), 'Invalid PNG row filter')


def public_png(data):
    """Remove capture metadata without changing encoded pixels or color chunks."""
    require(data.startswith(b'\x89PNG\r\n\x1a\n'), 'Invalid PNG signature')
    output, offset = bytearray(data[:8]), 8
    while offset < len(data):
        require(offset + 12 <= len(data), 'Truncated PNG chunk')
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        end = offset + length + 12
        require(end <= len(data), 'Truncated PNG payload')
        kind, body = data[offset + 4:offset + 8], data[offset + 8:end - 4]
        require(zlib.crc32(kind + body) == struct.unpack('>I', data[end - 4:end])[0], 'PNG checksum mismatch')
        if kind not in (b'eXIf', b'tEXt', b'zTXt', b'iTXt', b'tIME'):
            output.extend(data[offset:end])
        offset = end
    result = bytes(output)
    validate_png(result)
    return result


def validate_manifest(manifest, files):
    keys(manifest, 'schema entries files')
    require(manifest['schema'] == 1, 'Unsupported bundle schema')
    require(isinstance(manifest['entries'], list) and 0 < len(manifest['entries']) <= 64, 'Invalid entries')
    require(isinstance(manifest['files'], dict) and set(manifest['files']) == set(files), 'Unexpected or missing files')
    expected = set()
    ids = set()
    updates = 0
    for entry in manifest['entries']:
        keys(entry, 'id title category kind sourceRevision edits text images readmeUpdate', 'command')
        if 'command' in entry:
            require(string(entry['command'], 600).strip(), 'Empty example command')
        require(isinstance(entry['id'], str) and SLUG.fullmatch(entry['id']) and entry['id'] not in ids, 'Invalid or duplicate entry ID')
        ids.add(entry['id'])
        string(entry['title'], 160)
        string(entry['edits'], 2000)
        require(entry['category'] in CATEGORIES and entry['kind'] in ('staged', 'actual-vm'), 'Invalid gallery classification')
        require(isinstance(entry['sourceRevision'], str) and REV.fullmatch(entry['sourceRevision']), 'Invalid source revision')
        require(type(entry['readmeUpdate']) is bool, 'Invalid README designation')
        updates += entry['readmeUpdate']
        if entry['readmeUpdate']:
            require(entry['category'] == 'Update', 'README example must belong to Update')
        prefix = 'gallery/' + entry['id'] + '/'
        require(entry['text'] == prefix + 'text.txt', 'Unexpected text path')
        require(isinstance(entry['images'], list) and 0 < len(entry['images']) <= 32, 'Invalid image list')
        require(entry['images'] == [prefix + f'output-{i:03}.png' for i in range(1, len(entry['images']) + 1)], 'Unexpected image paths')
        expected.update([entry['text']] + entry['images'])
    require(updates <= 1 and expected == set(files), 'Unexpected publication files or repeated Update example')
    require(sum(len(data) for data in files.values()) <= MAX_TOTAL, 'Bundle exceeds size limit')
    for name, data in files.items():
        valid_path(name)
        require(0 < len(data) <= MAX_FILE, 'Invalid file size')
        record = manifest['files'][name]
        keys(record, 'sha256 size')
        require(record['sha256'] == digest(data) and type(record['size']) is int and record['size'] == len(data), 'File integrity mismatch: ' + name)
        if name.endswith('.png'):
            validate_png(data)
        else:
            string(data.decode('utf-8'), MAX_FILE)


def read_bundle(data, expected_sha=None):
    require(0 < len(data) <= MAX_ZIP, 'Archive exceeds compressed size limit')
    if expected_sha is not None:
        require(digest(data) == expected_sha, 'Bundle SHA-256 mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= 512 and len({i.filename for i in infos}) == len(infos), 'Duplicate or excessive archive entries')
        require(sum(i.file_size for i in infos) <= MAX_TOTAL + 1024 * 1024, 'Archive expansion limit exceeded')
        for info in infos:
            require(info.orig_filename == info.filename, 'Ambiguous archive filename')
            valid_path(info.filename)
            mode = info.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and not info.is_dir(), 'Only regular files are allowed')
            require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported ZIP encoding')
            require(info.file_size <= MAX_FILE and info.file_size <= max(1, info.compress_size) * 200, 'Oversize or suspicious compression ratio')
        require('manifest.json' in archive.namelist(), 'Missing public manifest')
        require(archive.getinfo('manifest.json').file_size <= 1024 * 1024, 'Oversize manifest')
        manifest = load_json(archive.read('manifest.json'))
        # Validate paths and member bounds before reading; never extract ZIP paths.
        files = {i.filename: archive.read(i) for i in infos if i.filename != 'manifest.json'}
    validate_manifest(manifest, files)
    return manifest, files


def read_regular(path, limit=MAX_FILE):
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= limit, 'Expected bounded regular input: ' + str(path))
    return path.read_bytes()


def new_output(path):
    require(not path.exists() and not path.is_symlink(), 'Output exists; choose a new path to preserve prior evidence')
    if path.resolve().is_relative_to(ROOT):
        ignored = subprocess.run(['git', 'check-ignore', '--no-index', '-q', str(path / 'probe')], cwd=ROOT)
        require(ignored.returncode == 0, 'Generated output inside checkout must be Git-ignored')
    path.parent.mkdir(parents=True, exist_ok=True)


def pack(gallery, selection_path, output):
    selection = load_json(read_regular(selection_path, 1024 * 1024))
    keys(selection, 'schema entries')
    require(selection['schema'] == 1 and isinstance(selection['entries'], list), 'Invalid publication selection')
    generation = load_json(read_regular(gallery / 'manifest.json', 4 * 1024 * 1024))
    generated = {entry['id']: entry for entry in generation['scenarios']}
    entries, files = [], {}
    for selected in selection['entries']:
        keys(selected, 'scenario id title edits approvedForPublication readmeUpdate', 'command')
        require(selected['approvedForPublication'] is True, 'Explicit file publication approval is required')
        require(isinstance(selected['scenario'], str) and SLUG.fullmatch(selected['scenario']), 'Invalid scenario')
        require(isinstance(selected['id'], str) and SLUG.fullmatch(selected['id']), 'Invalid public ID')
        require(selected['scenario'] in generated, 'Unknown scenario')
        scenario = generated[selected['scenario']]
        if scenario.get('commandCaptionReviewed') is True:
            require(selected.get('command') == scenario.get('command') and bool(selected.get('command')),
                    'Captioned command requires matching explicit publication selection')
        folder = gallery / selected['scenario']
        require(not folder.is_symlink(), 'Symlink scenario directory')
        entry = {key: scenario[key] for key in ('category', 'kind', 'sourceRevision')}
        entry.update({key: selected[key] for key in ('id', 'title', 'edits', 'readmeUpdate')})
        if 'command' in selected:
            entry['command'] = selected['command']
        prefix = 'gallery/' + selected['id'] + '/'
        entry['text'] = prefix + 'text.txt'
        report = load_json(read_regular(folder / 'output.json', MAX_FILE))
        text = read_regular(folder / 'text.txt')
        require(report['text'] == text.decode('utf-8'), 'Renderer and accessible text disagree')
        images = sorted(name for name in scenario['files'] if re.fullmatch(r'output-[0-9]{3}\.png', name))
        entry['images'] = [prefix + name for name in images]
        for name in ['text.txt', 'output.json'] + images:
            data = read_regular(folder / name)
            require(digest(data) == scenario['files'][name], 'Generation hash mismatch: ' + name)
            if name != 'output.json':
                files[prefix + name] = public_png(data) if name.endswith('.png') else data
        entries.append(entry)
    manifest = {'schema': 1, 'entries': entries, 'files': {name: {'sha256': digest(data), 'size': len(data)} for name, data in files.items()}}
    data = write_bundle(manifest, files, output)
    print(json.dumps({'bundle': str(output), 'size': len(data), 'sha256': digest(data), 'entries': len(entries)}))


def write_bundle(manifest, files, output):
    """Write a deterministic, verified complete bundle without replacing prior output."""
    validate_manifest(manifest, files)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in [('manifest.json', json_bytes(manifest))] + sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, data)
    data = buffer.getvalue()
    read_bundle(data)
    new_output(output)
    with output.open('xb') as handle:
        handle.write(data)
    return data


def replace_examples(pin_path, bundle, replacement, replacement_sha256, entry_ids, output):
    """Replace an explicit exact set of entries; never add or drop gallery entries."""
    pin = load_json(read_regular(pin_path, 1024 * 1024))
    validate_pin(pin)
    require(pin['mode'] == 'release', 'Replacement requires an approved release pin, not bootstrap mode')
    require(isinstance(replacement_sha256, str) and SHA.fullmatch(replacement_sha256), 'Invalid replacement SHA-256')
    require(entry_ids and all(isinstance(name, str) and SLUG.fullmatch(name) for name in entry_ids)
            and len(entry_ids) == len(set(entry_ids)), 'Expected unique replacement entry IDs')
    original = read_regular(bundle, MAX_ZIP) if bundle is not None else retrieve(pin)
    require(len(original) == pin['asset']['size'], 'Pinned bundle length mismatch')
    manifest, files = read_bundle(original, pin['asset']['sha256'])
    replacements, replacement_files = read_bundle(read_regular(replacement, MAX_ZIP), replacement_sha256)
    selected = set(entry_ids)
    by_id = {entry['id']: entry for entry in replacements['entries']}
    require(set(by_id) == selected, 'Replacement bundle must contain exactly the selected entries')
    require(selected <= {entry['id'] for entry in manifest['entries']}, 'Cannot replace unknown entries')
    entries, combined = [], {}
    for entry in manifest['entries']:
        replaced = entry['id'] in selected
        current = by_id[entry['id']] if replaced else entry
        entries.append(current)
        source = replacement_files if replaced else files
        for name in [current['text']] + current['images']:
            combined[name] = source[name]
    result = {'schema': 1, 'entries': entries,
              'files': {name: {'sha256': digest(data), 'size': len(data)} for name, data in combined.items()}}
    require(not any(entry['readmeUpdate'] for entry in manifest['entries'])
            or any(entry['readmeUpdate'] for entry in entries), 'Cannot remove the canonical README Update designation')
    data = write_bundle(result, combined, output)
    print(json.dumps({'bundle': str(output), 'size': len(data), 'sha256': digest(data), 'entries': len(entries),
                      'replaced': entry_ids, 'retained': [entry['id'] for entry in entries if entry['id'] not in selected],
                      'baseAssetId': pin['asset']['id'], 'baseSha256': pin['asset']['sha256'],
                      'replacementSha256': replacement_sha256}))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(parsed.scheme == 'https' and parsed.hostname in ('api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'), 'Unexpected asset redirect')
        redirected = super().redirect_request(request, fp, code, message, headers, newurl)
        redirected.remove_header('Authorization')
        return redirected


def github(endpoint, binary=False):
    headers = {'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ballin-site-build'}
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(API + endpoint, headers=headers)
    with urllib.request.build_opener(SafeRedirect()).open(request, timeout=30) as response:
        data = response.read((MAX_ZIP if binary else 4 * 1024 * 1024) + 1)
    require(len(data) <= (MAX_ZIP if binary else 4 * 1024 * 1024), 'GitHub response exceeds limit')
    return data if binary else load_json(data)


def validate_pin(pin):
    require(isinstance(pin, dict) and pin.get('mode') in ('bootstrap', 'release'), 'Explicit bundle mode is required')
    if pin['mode'] == 'bootstrap':
        keys(pin, 'mode reason')
        string(pin['reason'])
        return
    keys(pin, 'mode release asset')
    keys(pin['release'], 'id tag commit')
    keys(pin['asset'], 'id name size sha256')
    release, asset = pin['release'], pin['asset']
    require(type(release['id']) is int and release['id'] > 0 and type(asset['id']) is int and asset['id'] > 0, 'Invalid immutable identity')
    require(isinstance(release['tag'], str) and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', release['tag']), 'Expected stable product tag')
    require(isinstance(release['commit'], str) and REV.fullmatch(release['commit']), 'Invalid product commit')
    require(isinstance(asset['name'], str) and re.fullmatch(r'ballin-gallery-[a-z0-9.-]+\.zip', asset['name']), 'Unexpected asset name')
    require(type(asset['size']) is int and 0 < asset['size'] <= MAX_ZIP and isinstance(asset['sha256'], str) and SHA.fullmatch(asset['sha256']), 'Invalid asset integrity pin')


def retrieve(pin, request=github):
    validate_pin(pin)
    require(pin['mode'] == 'release', 'No release bundle in bootstrap mode')
    release, asset = pin['release'], pin['asset']
    metadata = request('/releases/' + str(release['id']))
    require(metadata['id'] == release['id'] and metadata['tag_name'] == release['tag'] and metadata['draft'] is False and metadata['prerelease'] is False and metadata.get('published_at'), 'Pinned stable release identity changed')
    ref = request('/git/ref/tags/' + release['tag'])['object']
    for _ in range(5):
        if ref['type'] == 'commit':
            break
        require(ref['type'] == 'tag' and REV.fullmatch(ref['sha']), 'Unexpected tag object')
        ref = request('/git/tags/' + ref['sha'])['object']
    require(ref['type'] == 'commit' and ref['sha'] == release['commit'], 'Version tag no longer matches pinned commit')
    actual = request('/releases/assets/' + str(asset['id']))
    require(any(item['id'] == asset['id'] for item in metadata['assets']), 'Asset is not attached to pinned product release')
    require(actual['id'] == asset['id'] and actual['name'] == asset['name'] and actual['size'] == asset['size'] and actual['state'] == 'uploaded', 'Pinned asset metadata changed')
    if actual.get('digest'):
        require(actual['digest'] == 'sha256:' + asset['sha256'], 'GitHub asset digest mismatch')
    data = request('/releases/assets/' + str(asset['id']), binary=True)
    require(len(data) == asset['size'], 'Asset length mismatch')
    read_bundle(data, asset['sha256'])
    return data


def capture_details(entry):
    revision = entry['sourceRevision']
    command = ''
    if entry.get('command'):
        label = 'Recorded command' if entry['kind'] == 'actual-vm' else 'Illustrative command'
        command = f'<p>{label}</p><pre><code>$ {html.escape(entry["command"])}</code></pre>'
    return (f'<details class="provenance"><summary>Details</summary>'
            f'{command}<p>Source: <a href="https://github.com/{REPO}/commit/{revision}"><code>{revision}</code></a><br>'
            f'{html.escape(entry["edits"])}</p></details>')


def example_guide(entry):
    command = entry.get('command', '')
    if command == 'ballin setup':
        guide = ('optional-capabilities.html#guided-preference-review', 'Preference setup guide')
    elif command.startswith('ballin backup setup'):
        guide = ('installation.html#optional-backup-setup-and-reconnect', 'Backup setup guide')
    elif command.startswith(('ballin backup list', 'ballin backup read')):
        guide = ('installation.html#inspect-saved-backups', 'Inspect saved backups')
    elif command == 'ballin backup':
        guide = ('capabilities.html#ballin-backup', 'Backup guide')
    elif entry['category'] == 'Install & Quickstart':
        guide = ('installation.html#install', 'Installation guide')
    elif entry['category'] == 'Update':
        guide = ('capabilities.html#ballin-update', 'Update guide')
    else:
        guide = ('commands.html', 'Command reference')
    return guide


def command_html(entry, base=""):
    if 'command' not in entry:
        return ''
    guide = example_guide(entry)
    return f'<p class="example-guide"><a href="{base}/docs/{guide[0]}">{guide[1]}</a></p>'


def add_gallery_section_links(page, manifest, base):
    """Link existing guide sections to the examples actually in this bundle."""
    if not manifest:
        return page['content']
    links = {}
    for entry in manifest['entries']:
        if not entry.get('command'):
            continue
        target, _, anchor = example_guide(entry)[0].partition('#')
        if page['path'] != 'docs/' + target or not anchor:
            continue
        links.setdefault(anchor, []).append(
            f'<a href="{base}/gallery/#entry-{entry["id"]}">{html.escape(entry["title"])}</a>')
    content = page['content']
    for anchor, items in links.items():
        pattern = r'(<h[1-6] id="' + re.escape(anchor) + r'"[^>]*>.*?</h[1-6]>)'
        content = re.sub(pattern, lambda match: match[1] + '<p class="gallery-related">Examples: '
                         + ' · '.join(items) + '</p>', content, count=1, flags=re.S)
    return content



def gallery_html(manifest, files, base):
    lines = ['<h1 id="gallery">Output gallery</h1>',
             '<p>Explore Ballin’s terminal output, rendered from VM recordings or staged examples.</p>']
    lines.append('<nav class="gallery-topics" aria-label="Gallery sections">')
    topic_labels = {'Install & Quickstart': 'Installing', 'Setup & Backup': 'Backups & preferences', 'Update': 'Updating', 'Diagnostics': 'Diagnostics'}
    for category in CATEGORIES:
        slug = category.lower().replace(' & ', '-').replace(' ', '-')
        lines.append(f'<a href="#{slug}">{html.escape(topic_labels[category])}</a> ')
    lines.append('</nav>')
    first = True
    for category in CATEGORIES:
        slug = category.lower().replace(' & ', '-').replace(' ', '-')
        lines.append(f'<h2 id="{slug}">{html.escape(category)}</h2>')
        entries = [entry for entry in manifest['entries'] if entry['category'] == category]
        if not entries:
            lines.append('<p>No examples yet.</p>')
        for entry in entries:
            ident = entry['id']
            title = html.escape(entry['title'])
            label = 'VM recording' if entry['kind'] == 'actual-vm' else 'Staged example'
            lines.append(f'<article class="gallery-entry" id="entry-{ident}"><h3>{title}</h3><p class="capture-label">{label}</p>')
            image = entry['images'][0]
            viewer = image.removesuffix('.png') + '.html'
            width, height = struct.unpack('>II', files[image][16:24])
            if height > 400:
                width, height = max(1, round(width * 400 / height)), 400
            count = len(entry['images'])
            expanded = ' open' if first else ''
            first = False
            lines.append(f'<details class="gallery-output"{expanded}><summary>Example output</summary>'
                         f'<p class="image-actions"><a href="{base}/{viewer}">Open image viewer</a>'
                         f'<a href="#transcript-{ident}">Text version</a></p>'
                         + command_html(entry, base)
                         + image_page_navigation(entry, 0, base)
                         + f'<figure><a href="{base}/{viewer}" aria-label="Open {title} image viewer"><img loading="lazy" width="{width}" height="{height}" '
                         f'src="{base}/{image}" alt="{title}, rendered page 1"></a>'
                         + (f'<figcaption>Page 1 of {count}</figcaption>' if count > 1 else '')
                         + '</figure>')
            lines.append(transcript_html(entry, files, base) + '</details>' + capture_details(entry) + '</article>')
    return '\n'.join(lines)


def transcript_html(entry, files, base, suffix=''):
    identifier = entry['id'] + suffix
    text = html.escape(files[entry['text']].decode('utf-8'))
    return (f'<details id="transcript-{identifier}"><summary>Text version</summary>'
            f'<button type="button" hidden data-copy="text-{identifier}" data-status="copy-status-{identifier}" aria-describedby="copy-status-{identifier}">Copy text</button>'
            f'<span id="copy-status-{identifier}" class="copy-status" role="status" aria-live="polite"></span>'
            f'<pre><code id="text-{identifier}">{text}</code></pre>'
            f'<a download href="{base}/{entry["text"]}">Download text</a></details>')


def image_page_navigation(entry, index, base):
    if len(entry['images']) < 2:
        return ''
    links = []
    for number, image in enumerate(entry['images'], 1):
        label = f'Page {number}'
        if number == index:
            links.append(f'<span aria-current="page">{label}</span>')
        else:
            links.append(f'<a href="{base}/{image.removesuffix(".png")}.html">{label}</a>')
    return '<nav class="image-pages" aria-label="Example pages">' + ''.join(links) + '</nav>'


def image_pages(manifest, files, base):
    pages = []
    for entry in manifest['entries']:
        for index, image in enumerate(entry['images'], 1):
            width, height = struct.unpack('>II', files[image][16:24])
            title = html.escape(entry['title'])
            label = 'VM recording' if entry['kind'] == 'actual-vm' else 'Staged example'
            content = (f'<h1>{title}</h1><p class="image-actions"><a href="{base}/gallery/#entry-{entry["id"]}">Back to gallery example</a></p>'
                       f'<p class="capture-label">{label} · Page {index} of {len(entry["images"])}</p>'
                       + image_page_navigation(entry, index, base)
                       + f'<p class="image-actions"><a href="{base}/{image}">Open original PNG</a>'
                       f'<a href="#transcript-{entry["id"]}-image">Text version</a></p>'
                       + command_html(entry, base)
                       + f'<figure class="image-preview"><img width="{width}" height="{height}" src="{base}/{image}" '
                       f'alt="{html.escape(entry["title"], quote=True)}, rendered page {index}"></figure>'
                       + image_page_navigation(entry, index, base)
                       + transcript_html(entry, files, base, '-image') + capture_details(entry))
            pages.append({'path': image.removesuffix('.png') + '.html', 'title': f"{entry['title']} — page {index} of {len(entry['images'])}", 'source': 'tools/output-gallery/README.md', 'content': content})
    return pages


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.links = set(), []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            require(attrs['id'] not in self.ids, 'Duplicate HTML anchor: ' + attrs['id'])
            self.ids.add(attrs['id'])
        for key in ('href', 'src'):
            if key in attrs:
                self.links.append(attrs[key])
        if tag == 'img':
            require(bool(attrs.get('alt')), 'Image missing alt text')


def verify_site(output, base):
    parsed = {}
    for file in output.rglob('*.html'):
        parser = Links()
        parser.feed(file.read_text())
        parsed[file.relative_to(output).as_posix()] = parser
    for name, parser in parsed.items():
        for link in parser.links:
            url = urllib.parse.urlsplit(link)
            if url.scheme or url.netloc:
                continue
            path = urllib.parse.unquote(url.path)
            if path.startswith('/'):
                require(path.startswith(base + '/'), 'Link lost project base path: ' + link)
                path = path[len(base) + 1:]
            else:
                path = str(PurePosixPath(name).parent / path) if path else name
            if url.path.endswith('/'):
                path = str(PurePosixPath(path) / 'index.html')
            target = output / path
            require(target.resolve().is_relative_to(output.resolve()) and target.is_file(), 'Broken local link from ' + name + ': ' + link)
            if url.fragment:
                require(path in parsed and urllib.parse.unquote(url.fragment) in parsed[path].ids, 'Broken local anchor from ' + name + ': ' + link)


def related_gallery(source, base, enabled):
    if not enabled:
        return ''
    targets = {
        'docs/what-is-ballin.md': ('', 'Browse the output gallery'),
        'docs/README.md': ('', 'Explore command output in the gallery'),
        'docs/quickstart.md': ('#install-quickstart', 'See installation examples'),
        'docs/commands.md': ('', 'See command output examples'),
        'docs/backup-sources.md': ('#setup-backup', 'See backup examples'),
    }
    if source not in targets:
        return ''
    anchor, label = targets[source]
    return f'<p class="gallery-related"><a href="{base}/gallery/{anchor}">{label}</a></p>'


def section_current(path, section):
    if path == f'{section}/index.html':
        return ' aria-current="page"'
    if path.startswith(f'{section}/'):
        return ' aria-current="location"'
    return ''


def page_url(path, base, origin):
    if PurePosixPath(path).name == 'index.html':
        path = path.removesuffix('index.html')
    return origin + base + '/' + urllib.parse.quote(path)


def page_metadata(page, base, origin):
    """Static sharing metadata; titles stay topic-first except the product home."""
    topic = page['title'].strip()
    require(bool(topic), 'Page title must not be empty: ' + page['path'])
    title = 'Ballin — Back up dotfiles and update your Mac' if page['path'] == 'index.html' else topic + ' · Ballin'
    description = 'Back up your dotfiles and keep your macOS development tools current.'
    if page['path'] != 'index.html':
        description = topic + ' — ' + description
    values = {
        'pageTitle': title, 'description': description,
        'canonical': page_url(page['path'], base, origin),
        'shareImage': origin + base + '/docs/assets/brand/social-preview.png',
        'shareAlt': 'Ballin: Back up dotfiles. Keep your tools current.',
    }
    return {key: html.escape(value, quote=True) for key, value in values.items()}


def analytics_config(path):
    config = load_json(read_regular(path, 4096))
    require(isinstance(config, dict) and set(config) == {'token'}, 'Analytics configuration requires only token')
    token = config['token']
    require(token is None or (isinstance(token, str) and re.fullmatch(r'[a-f0-9]{32}', token)),
            'Analytics token must be null or a 32-character lowercase hexadecimal public site token')
    return token


def build(output, pin_path, base, local_bundle=None, origin='https://jballin.github.io', analytics_token=None):
    require(base == '' or re.fullmatch(r'/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', base), 'Invalid site base path')
    require(re.fullmatch(r'https://[a-zA-Z0-9.-]+', origin), 'Invalid canonical origin')
    require(analytics_token is None or (isinstance(analytics_token, str) and re.fullmatch(r'[a-f0-9]{32}', analytics_token)), 'Invalid analytics token')
    pin = load_json(read_regular(pin_path, 1024 * 1024))
    validate_pin(pin)
    manifest, files = None, {}
    if pin['mode'] == 'release':
        data = read_regular(local_bundle, MAX_ZIP) if local_bundle else retrieve(pin)
        require(len(data) == pin['asset']['size'], 'Local bundle size does not match pin')
        manifest, files = read_bundle(data, pin['asset']['sha256'])
    else:
        require(local_bundle is None, 'Bootstrap cannot silently accept an unpinned bundle')
    new_output(output)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT).strip())
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    candidates = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    sources = sorted(p for p in candidates if p in ('README.md', 'CONTRIBUTING.md', '.github/SUPPORT.md', '.github/SECURITY.md', 'LICENSE.md') or re.fullmatch(r'docs/[^/]+\.md', p))
    source_base = f'https://github.com/{REPO}/blob/{revision}'
    payload = {'pages': [{'path': p, 'text': (ROOT / p).read_text()} for p in sources], 'base': base, 'sourceBase': source_base}
    pages = json.loads(subprocess.check_output(['node', str(ROOT / 'tools/site/markdown.cjs')], input=json_bytes(payload), cwd=ROOT))
    template = (ROOT / 'site/page.html').read_text()
    if manifest:
        pages.append({'path': 'gallery/index.html', 'title': 'Output gallery', 'source': 'tools/output-gallery/README.md', 'content': gallery_html(manifest, files, base)})
        pages.extend(image_pages(manifest, files, base))
    work = Path(tempfile.mkdtemp(prefix='.site-build-', dir=output.parent))
    try:
        for page in pages:
            values = {**page_metadata(page, base, origin), 'base': base,
                      'analytics': (f'<script src="{base}/analytics.js" data-token="{analytics_token}" data-origin="{origin}" defer></script>' if analytics_token else ''),
                      'docsCurrent': section_current(page['path'], 'docs'),
                      'galleryNav': f'<a href="{base}/gallery/"{section_current(page["path"], "gallery")}>Gallery</a>' if manifest else '',
                      'content': add_gallery_section_links(page, manifest, base) + related_gallery(page['source'], base, manifest is not None), 'source': source_base + '/' + urllib.parse.quote(page['source'])}
            rendered = re.sub(r'\{\{(\w+)\}\}', lambda m: values[m[1]], template)
            target = work / page['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(rendered)
        shutil.copyfile(ROOT / 'site/style.css', work / 'style.css')
        for asset in ('favicon.svg', 'gallery.js', 'analytics.js'):
            shutil.copyfile(ROOT / 'site' / asset, work / asset)
        for path in tracked:
            if path.startswith('docs/assets/') and Path(path).suffix in ('.png', '.svg'):
                target = work / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(read_regular(ROOT / path))
        for path, data in files.items():
            target = work / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if manifest:
            # Keep old Gallery links and their fragments usable.
            shutil.copyfile(work / 'gallery/index.html', work / 'gallery.html')
            (work / 'gallery/manifest.json').write_bytes(json_bytes(manifest))
        (work / '.nojekyll').write_text('')
        (work / 'build.json').write_bytes(json_bytes({'sourceRevision': revision, 'sourceWorktreeDirty': dirty, 'hosting': {'origin': origin, 'base': base}, 'bundle': pin}))
        urls = ''.join('<url><loc>' + html.escape(page_url(p['path'], base, origin)) + '</loc></url>' for p in pages)
        (work / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>')
        (work / 'robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: ' + origin + base + '/sitemap.xml\n')
        verify_site(work, base)
        work.rename(output)
    except Exception:
        print('Incomplete build retained for diagnosis: ' + str(work))
        raise
    print('Complete site: ' + str(output))


def readme_example(bundle, image_base=None):
    manifest, files = read_bundle(read_regular(bundle, MAX_ZIP))
    entries = [e for e in manifest['entries'] if e['readmeUpdate']]
    require(len(entries) == 1, 'Designate exactly one canonical README Update entry')
    entry = entries[0]
    images = ''
    disclosure = html.escape(entry['edits']).replace('\n', '<br>')
    if image_base:
        require(re.fullmatch(r'https://[a-zA-Z0-9.-]+(?:/[a-zA-Z0-9_-]+)*', image_base), 'Invalid image base')
        label = 'Staged demonstration: ' if entry['kind'] == 'staged' else 'Actual VM capture: '
        images = '\n'.join(f'<img src="{image_base}/{image}" alt="{html.escape(label + entry["title"], quote=True)}, page {index}">' for index, image in enumerate(entry['images'], 1)) + '\n\n'
    # HTML escaping prevents recorded text from closing the details or code block.
    source = '[`' + entry['sourceRevision'][:12] + '`](https://github.com/' + REPO + '/tree/' + entry['sourceRevision'] + ')'
    print(images + '<details>\n<summary>Example output</summary>\n\n' + html.escape(entry['kind']) + ' · Source: ' + source + '\n\n<p>' + disclosure + '</p>\n\n<details>\n<summary>Text version</summary>\n\n<pre><code>' + html.escape(files[entry['text']].decode()) + '</code></pre>\n\n</details>\n</details>')


def deployment_config(path):
    config = load_json(read_regular(path, 4096))
    require(isinstance(config, dict) and set(config) == {'origin', 'base'}, 'Deployment configuration requires only origin and base')
    require(isinstance(config['origin'], str) and re.fullmatch(r'https://[a-zA-Z0-9.-]+', config['origin']), 'Invalid canonical origin')
    require(isinstance(config['base'], str) and re.fullmatch(r'(?:/[a-zA-Z0-9_-]+)*', config['base']), 'Invalid site base path')
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    package = commands.add_parser('pack', help='Create a minimal ZIP from explicitly approved scenario files')
    package.add_argument('--gallery', type=Path, required=True)
    package.add_argument('--selection', type=Path, required=True)
    package.add_argument('--output', type=Path, required=True)
    refresh = commands.add_parser('replace', help='Replace selected complete examples in a verified pinned bundle')
    refresh.add_argument('--pin', type=Path, default=ROOT / 'site/bundle.json')
    refresh.add_argument('--bundle', type=Path, help='Offline base bundle; must match the release pin exactly')
    refresh.add_argument('--replacement', type=Path, required=True, help='ZIP containing only the reviewed replacement entries')
    refresh.add_argument('--replacement-sha256', required=True, help='Reviewed replacement ZIP SHA-256')
    refresh.add_argument('--entry', action='append', required=True, help='Existing public entry ID to replace; repeat for each entry')
    refresh.add_argument('--output', type=Path, required=True)
    inspect = commands.add_parser('inspect', help='Validate and print only public bundle metadata')
    inspect.add_argument('bundle', type=Path)
    compile_site = commands.add_parser('build')
    compile_site.add_argument('--output', type=Path, default=ROOT / '.site-output/site')
    compile_site.add_argument('--pin', type=Path, default=ROOT / 'site/bundle.json')
    compile_site.add_argument('--config', type=Path, default=ROOT / 'site/deployment.json', help='Canonical origin and base configuration')
    compile_site.add_argument('--origin', help='Override the configured HTTPS canonical origin')
    compile_site.add_argument('--base', help='Override the configured path; use an empty string for a root site')
    compile_site.add_argument('--analytics', action='store_true', help='Enable the configured public Cloudflare site token; omitted for local builds')
    compile_site.add_argument('--analytics-config', type=Path, default=ROOT / 'site/analytics.json')
    compile_site.add_argument('--bundle', type=Path, help='Offline bundle; still checked against the release pin')
    example = commands.add_parser('readme-example', help='Print matching expandable Update text; never edit README')
    example.add_argument('bundle', type=Path)
    example.add_argument('--image-base', help='Include canonical images only after verifying the public base URL')
    args = parser.parse_args()
    try:
        if args.command == 'pack':
            pack(args.gallery, args.selection, args.output)
        elif args.command == 'replace':
            replace_examples(args.pin, args.bundle, args.replacement, args.replacement_sha256, args.entry, args.output)
        elif args.command == 'inspect':
            manifest, _ = read_bundle(read_regular(args.bundle, MAX_ZIP))
            print(json.dumps(manifest, indent=2))
        elif args.command == 'readme-example':
            readme_example(args.bundle, args.image_base)
        else:
            config = deployment_config(args.config)
            build(args.output, args.pin, args.base if args.base is not None else config['base'], args.bundle,
                  args.origin if args.origin is not None else config['origin'],
                  analytics_config(args.analytics_config) if args.analytics else None)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, 'Site operation failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
