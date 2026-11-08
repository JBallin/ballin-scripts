#!/usr/bin/env python3
"""Build or serve the standard local preview at one stable path and port."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('ballin_site', Path(__file__).with_name('site.py'))
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
LOCAL = site.ROOT / '.site-output/local'


def rebuild(local=LOCAL):
    # Refuse redirected storage and arbitrary existing data rather than replacing it.
    site.require(not local.parent.is_symlink() and not local.is_symlink(), 'Local preview storage must not be a symlink')
    local.mkdir(parents=True, exist_ok=True)
    builds = local / 'builds'
    site.require(not builds.is_symlink(), 'Local build storage must not be a symlink')
    builds.mkdir(exist_ok=True)
    current = local / 'current'
    if current.is_symlink():
        target = Path(os.readlink(current))
        site.require(not target.is_absolute() and len(target.parts) == 3 and target.parts[0] == 'builds'
                     and target.parts[1].startswith('build-') and target.parts[2] == 'site'
                     and current.resolve().is_relative_to(builds.resolve())
                     and (current / 'build.json').is_file(), 'Refusing to replace an unmanaged local preview link')
    else:
        site.require(not current.exists(), 'Refusing to replace an existing local preview directory or file')
    # Serialize rebuilds without deleting a possibly active lock after interruption.
    lock = local / 'build.lock'
    site.require(not lock.is_symlink(), 'Local build lock must not be a symlink')
    with lock.open('a') as lockfile:
        import fcntl
        try:
            fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('Another local rebuild is running; wait for it to finish') from error
        candidate = Path(tempfile.mkdtemp(prefix='build-', dir=builds)) / 'site'
        config = site.deployment_config(site.ROOT / 'site/deployment.json')
        site.build(candidate, site.ROOT / 'site/bundle.json', '', origin=config['origin'])
        # Only complete validated snapshots become current; preserve old evidence.
        link = candidate.parent / 'current-link'
        link.symlink_to(candidate.relative_to(local))
        os.replace(link, current)
    print('Local preview rebuilt: ' + str(current))
    print('Refresh http://localhost:8000/ (no server restart needed)')
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['build', 'serve'])
    args = parser.parse_args()
    try:
        if args.command == 'build':
            rebuild()
        else:
            current = LOCAL / 'current'
            site.require(current.is_symlink() and (current / 'build.json').is_file(), 'Run python3 tools/site/local.py build first')
            metadata = json.loads((current / 'build.json').read_text())
            site.require(metadata.get('hosting', {}).get('base') == '', 'Standard local preview requires a root-hosted build')
            subprocess.run([sys.executable, str(Path(__file__).with_name('preview.py')), '--site', str(current), '--port', '8000'], check=True)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'Local preview failed: ' + str(error) + '\n')
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
