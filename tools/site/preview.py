#!/usr/bin/env python3
"""Serve one complete site snapshot on loopback, preserving its project base."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import re
import urllib.parse


def selected_file(site, base, request_path):
    site = site.resolve()
    path = urllib.parse.unquote(urllib.parse.urlsplit(request_path).path)
    if not path.startswith(base + '/') or '\0' in path:
        return None
    relative = path[len(base) + 1:]
    if any(part in ('.', '..') for part in relative.split('/')):
        return None
    target = (site / relative).resolve()
    if not target.is_relative_to(site):
        return None
    if target.is_dir():
        target = (target / 'index.html').resolve()
    if not target.is_relative_to(site):
        return None
    return target if target.is_file() else None


class Preview(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, site, base, **kwargs):
        self.site, self.base = site, base
        super().__init__(*args, directory=str(site), **kwargs)

    def translate_path(self, path):
        return str(selected_file(self.site, self.base, path))

    def do_GET(self):
        if self.path in ('/', self.base):
            self.send_response(302)
            self.send_header('Location', self.base + '/index.html')
            self.end_headers()
        elif selected_file(self.site, self.base, self.path) is None:
            self.send_error(404)
        else:
            super().do_GET()

    def do_HEAD(self):
        if selected_file(self.site, self.base, self.path) is None:
            self.send_error(404)
        else:
            super().do_HEAD()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True, type=Path, help='One complete build output, not its parent directory')
    parser.add_argument('--base', default='/ballin-scripts')
    parser.add_argument('--port', type=int, default=8000, help='Use 0 to choose a free port')
    args = parser.parse_args()
    if not re.fullmatch(r'(?:/[a-zA-Z0-9_-]+)*', args.base) or not 0 <= args.port <= 65535:
        parser.error('Invalid project base or port')
    site = args.site.resolve()
    if not (site / 'build.json').is_file() or not (site / 'index.html').is_file():
        parser.error('--site must select a complete generated snapshot')
    metadata = json.loads((site / 'build.json').read_text())
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Preview, site=site, base=args.base))
    print(json.dumps({'pid': os.getpid(), 'url': f'http://127.0.0.1:{server.server_port}{args.base}/index.html',
                      'site': str(site), 'sourceRevision': metadata['sourceRevision'],
                      'sourceWorktreeDirty': metadata['sourceWorktreeDirty'], 'bundleMode': metadata['bundle']['mode']}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
