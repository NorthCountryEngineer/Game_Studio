"""Plan locally, or explicitly download two hash-pinned public vision wheels.

No cloud resources, credentials, subscriptions, installs or provider calls.
"""
import argparse
import hashlib
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen
from sketch_runtime import DEFAULT_WHEELS, locked_wheels, wheel_files


def prepare(destination, download=False):
    destination = Path(destination).resolve()
    for wheel in locked_wheels():
        print(f"{wheel['name']} {wheel['version']}: {wheel['filename']} SHA256 {wheel['sha256']}")
        if not download:
            continue
        target = destination / wheel['filename']
        if target.is_file() and not target.is_symlink() and target.stat().st_size == wheel['size'] and hashlib.sha256(target.read_bytes()).hexdigest() == wheel['sha256']:
            continue
        url = urlparse(wheel['url'])
        if url.scheme != 'https' or url.hostname != 'files.pythonhosted.org' or url.query or url.fragment:
            raise ValueError('Only exact pinned public PyPI wheels may be downloaded')
        with urlopen(wheel['url'], timeout=45) as response:
            final = urlparse(response.url)
            if final.scheme != 'https' or final.hostname != 'files.pythonhosted.org':
                raise ValueError('Unexpected wheel download redirect')
            data = response.read(wheel['size'] + 1)
        if len(data) != wheel['size'] or hashlib.sha256(data).hexdigest() != wheel['sha256']:
            raise ValueError('Downloaded wheel differs from pinned release')
        destination.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            raise ValueError('Wheel destination cannot be a symlink')
        target.write_bytes(data)
    if download:
        count = sum(1 for _ in wheel_files(destination))
        print(f'Verified {count} runtime members; no code was installed or executed.')
    else:
        print('Plan only. Use --download for bounded public downloads; no AWS request is made.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=DEFAULT_WHEELS)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    prepare(args.destination, args.download)
