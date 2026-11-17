"""Move shared inputs and their saved QuickLook references while services are stopped."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

spec = importlib.util.spec_from_file_location('storage_migration', Path(__file__).with_name('migrate-storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


def run(source, destination, quicklook, hook, source_base, apply=False):
    paths = [Path(p).absolute() for p in (source, destination, quicklook, hook, source_base)]
    for path in paths:
        storage.no_links(path)
    source, destination, quicklook, hook, source_base = [p.resolve() for p in paths]
    if not source.is_dir():
        raise ValueError(f'Missing source: {source}')
    if source == destination or source.is_relative_to(destination) or destination.is_relative_to(source):
        raise ValueError('Source and destination overlap')
    if destination.exists() and (not destination.is_dir() or storage.files(destination)):
        raise ValueError('Destination must be absent or contain only empty directories; never merge business files')
    if quicklook.is_relative_to(source) or quicklook.is_relative_to(destination):
        raise ValueError('QuickLook store must be separate from shared inputs')
    before = storage.files(source)
    recovery_names = {p.name for p in source.iterdir() if p.is_dir() and ".pre-central-" in p.name}
    active_files = {name: digest for name, digest in before.items() if Path(name).parts[0] not in recovery_names}
    state_before = storage.files(quicklook) if quicklook.is_dir() else None
    if state_before is not None and not hook.is_file():
        raise ValueError('QuickLook migration hook missing; update the child project first')
    print(json.dumps({'source': str(source), 'destination': str(destination), 'files': len(before),
                      'quicklook': str(quicklook) if state_before is not None else None}, ensure_ascii=False, indent=2))
    if not apply:
        return
    if os.name != 'nt':
        raise ValueError('Apply requires Windows stopped-process verification')
    command = r"Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^python(w)?\.exe$'} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, text=True, check=True)
    processes = json.loads(result.stdout or '[]')
    if isinstance(processes, dict):
        processes = [processes]
    if any(p['ProcessId'] != os.getpid() and 'migrate-shared.py' not in (p.get('CommandLine') or '') for p in processes):
        raise ValueError('Stop Python business services before migration')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.shared-migration-', dir=destination.parent))
    backup = destination.parent / 'backups' / ('shared-migration-' + uuid.uuid4().hex[:12])
    storage.no_links(backup)
    moves = []
    def move(old, new):
        old.rename(new)
        moves.append((old, new))
    try:
        shutil.copytree(source, stage / 'shared', ignore=lambda folder, names: recovery_names if Path(folder).resolve() == source else set())
        if storage.files(stage / 'shared') != active_files:
            raise ValueError('Shared copy verification failed')
        (stage / 'shared' / '原始销量').mkdir(exist_ok=True)
        if state_before is not None:
            shutil.copytree(quicklook, stage / 'quicklook')
            if storage.files(stage / 'quicklook') != state_before:
                raise ValueError('QuickLook copy verification failed')
            subprocess.run([sys.executable, '-B', str(hook), '--staged', str(stage / 'quicklook'),
                            '--old', str(source), '--new', str(destination), '--source-base', str(source_base)], check=True)
        if storage.files(source) != before or (state_before is not None and storage.files(quicklook) != state_before):
            raise ValueError('Data changed during migration; nothing activated')
        backup.mkdir(parents=True)
        if destination.exists():
            move(destination, backup / 'reserved-shared')
        move(source, backup / 'shared')
        move(stage / 'shared', destination)
        if state_before is not None:
            move(quicklook, backup / 'quicklook')
            move(stage / 'quicklook', quicklook)
        (backup / 'migration.json').write_text(json.dumps({'source': str(source), 'destination': str(destination),
            'quicklook': str(quicklook), 'activated': True, 'files': before}, ensure_ascii=False, indent=2), encoding='utf-8')
        stage.rmdir()
        print(f'Migration complete. Recovery copies: {backup}')
    except BaseException:
        for old, new in reversed(moves):
            if new.exists() and not old.exists():
                new.rename(old)
        raise


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, default=root.parent / '共享数据')
    p.add_argument('--destination', type=Path, default=root.parent / '工作台数据' / 'shared')
    p.add_argument('--quicklook', type=Path, default=root.parent / '工作台数据' / 'database' / 'quicklook')
    p.add_argument('--hook', type=Path, default=root.parent / '数据速查' / 'scripts' / 'migrate_storage.py')
    p.add_argument('--source-base', type=Path, default=root.parent / '数据速查')
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    run(a.source, a.destination, a.quicklook, a.hook, a.source_base, a.apply)
