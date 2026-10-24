"""Build a deterministic independent Lambda archive. No AWS or network access."""
import argparse
import hashlib
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]


def package_api(destination):
    destination = Path(destination).resolve()
    files = [(path, path.name) for path in sorted((ROOT / 'backend/nce_api').glob('*.py'))]
    registry = ROOT / 'config/agent-framework.json'
    if not registry.is_file():
        raise SystemExit('Missing config/agent-framework.json; the assistant registry is required.')
    adjacent = ROOT / 'backend/nce_api/agent-framework.json'
    if not adjacent.is_file() or adjacent.is_symlink() or adjacent.read_bytes() != registry.read_bytes():
        raise SystemExit('The Core-adjacent agent-framework.json must match canonical config/agent-framework.json.')
    files.append((registry, 'agent-framework.json'))
    # The optional compatibility module reads this only if it is present.
    architecture = ROOT / 'config/feedback-architecture.json'
    if architecture.is_file():
        files.append((architecture, 'feedback-architecture.json'))
    if not any(name == 'handler.py' for _, name in files):
        raise SystemExit('The Lambda handler module is missing.')
    if sum(path.stat().st_size for path, _ in files) > 8 * 1024 * 1024:
        raise SystemExit('The Lambda source exceeds the reviewed packaging bound.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        for path, name in files:
            if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
                raise SystemExit('Lambda sources must be regular files inside this repository.')
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    return hashlib.sha256(destination.read_bytes()).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'infra/aws/build/game-studio-api.zip')
    args = parser.parse_args()
    digest = package_api(args.output)
    print(f'{args.output.resolve()}\nSHA256 {digest}')
