"""Verify pinned public wheels and expose safe Lambda archive members offline."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WHEELS = ROOT / 'infra/aws/build/sketch-runtime-wheels'


def locked_wheels():
    lock = json.loads((ROOT / 'config/sketch-runtime-lock.json').read_text())
    if lock['python'] != '3.12' or lock['platform'] != 'linux-aarch64' or len(lock['wheels']) != 2:
        raise ValueError('Unexpected sketch runtime target')
    return lock['wheels']


def wheel_files(directory=DEFAULT_WHEELS):
    """Hash every wheel before considering any member; never execute/install it."""
    directory = Path(directory).resolve()
    wheels = locked_wheels()
    allowed = {'numpy', 'numpy.libs', 'PIL', 'pillow.libs',
               *[f"{wheel['name']}-{wheel['version']}.dist-info" for wheel in wheels]}
    total, seen = 0, set()
    for wheel in wheels:
        path = directory / wheel['filename']
        if not path.is_file() or path.is_symlink():
            raise ValueError('Prepare pinned vision wheels with scripts/prepare-sketch-runtime.py --download first')
        if path.stat().st_size != wheel['size'] or hashlib.sha256(path.read_bytes()).hexdigest() != wheel['sha256']:
            raise ValueError('Sketch runtime wheel integrity failure')
    for wheel in wheels:
        with ZipFile(directory / wheel['filename']) as archive:
            for member in sorted(archive.infolist(), key=lambda value: value.filename):
                name = member.filename
                parts = PurePosixPath(name).parts
                if (not parts or name.startswith('/') or '\\' in name or '..' in parts
                        or name.rstrip('/') != str(PurePosixPath(name))
                        or stat.S_ISLNK(member.external_attr >> 16)):
                    raise ValueError('Unsafe sketch runtime wheel member')
                if member.is_dir() or parts[0] not in allowed:
                    continue
                if '__pycache__' in parts or name.endswith(('.pyc', '.pyo')):
                    continue
                if name in seen or member.file_size > 40 * 1024 * 1024:
                    raise ValueError('Duplicate or oversized sketch runtime wheel member')
                total += member.file_size
                if total > 110 * 1024 * 1024:
                    raise ValueError('Sketch runtime exceeds reviewed uncompressed bound')
                seen.add(name)
                yield name, archive.read(member), name.endswith('.so') or '.so.' in name
