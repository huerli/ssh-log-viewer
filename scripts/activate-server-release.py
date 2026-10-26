"""Verify an uploaded release and atomically advance the update pointer."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root = Path('/srv/ssh-log-viewer')
tag = sys.argv[1]
if not re.fullmatch(r'[vV](0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag):
    raise ValueError('Expected stable release tag')
version = tuple(map(int, tag[1:].split('.')))
directory = root / 'releases' / tag
with (root / 'publish.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    manifest = json.loads((directory / 'latest.json').read_text())
    assert manifest['tag_name'] == tag
    for asset in manifest['assets']:
        name = asset['name']
        assert Path(name).name == name
        file = directory / name
        assert file.is_file() and file.stat().st_size == asset['size']
        if name.endswith('.update.json'):
            metadata = json.loads(file.read_text())
            assert metadata['version'] == tag[1:]
            assert Path(metadata['asset']).name == metadata['asset']
            installer = directory / metadata['asset']
            assert installer.stat().st_size == metadata['size']
            with installer.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            assert digest == metadata['sha256']
    latest = root / 'latest.json'
    if latest.exists():
        current = json.loads(latest.read_text())['tag_name'][1:]
        if tuple(map(int, current.split('.'))) > version:
            print('Retaining newer server release')
            sys.exit(0)
    temporary = root / 'latest.json.tmp'
    temporary.write_bytes((directory / 'latest.json').read_bytes())
    os.replace(temporary, latest)
print('Verified and activated ' + tag)
