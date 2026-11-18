"""Move stopped application stores to a single root; default is a read-only plan."""
import argparse, hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile, uuid
import stat
from pathlib import Path

def no_links(path):
    for node in [path,*path.parents]:
        if node.is_symlink() or (hasattr(node,'is_junction') and node.is_junction()):
            raise ValueError(f'Linked migration path: {node}')

def file_digest(path, *, require_idle):
    if require_idle:
        if os.name != 'nt':
            raise ValueError('执行迁移需要 Windows 文件占用检查。')
        import _winapi
        import msvcrt
        try:
            # Share mode zero tests the actual file against open readers and writers.
            handle = _winapi.CreateFile(str(path), _winapi.GENERIC_READ, 0, 0, _winapi.OPEN_EXISTING, 0, 0)
        except OSError as error:
            if error.winerror in (32, 33):
                raise ValueError(f'无法迁移正在使用的文件：{path}。请关闭使用它的服务或程序后重试。') from error
            raise
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            _winapi.CloseHandle(handle)
            raise
        stream = os.fdopen(fd, 'rb')
    else:
        stream = path.open('rb')
    with stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()


def files(root, *, require_idle=False):
    result={}
    for p in [root, *root.rglob('*')]:
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):
            raise ValueError(f'Linked migration source: {p}')
        if p.is_file():
            result[str(p.relative_to(root))]=file_digest(p, require_idle=require_idle)
    return result

def has_source_directory(source):
    try:
        mode = source.stat().st_mode
    except FileNotFoundError:
        print(f'跳过缺失的旧数据目录：{source}', file=sys.stderr)
        return False
    if not stat.S_ISDIR(mode):
        raise NotADirectoryError(str(source))
    return True

def run(manifest, apply=False):
    manifest=Path(manifest).resolve()
    config=json.loads(manifest.read_text(encoding='utf-8-sig'))
    base=manifest.parent
    no_links(base/config['destination'])
    target=(base/config['destination']).resolve()
    entries=[]
    skipped_stores = set()
    for entry in config['stores']:
        no_links(base/entry['source'])
        source=(base/entry['source']).resolve()
        relative=Path(entry['destination'])
        if relative.anchor or not relative.parts or '..' in relative.parts:raise ValueError('Invalid destination')
        if not has_source_directory(source):
            skipped_stores.add((source, relative))
            continue
        if target==source or target.is_relative_to(source) or source.is_relative_to(target):
            raise ValueError('Source and destination overlap')
        entries.append((source,relative))
    if not entries:
        print('没有需要迁移的旧数据目录。')
        return
    for i,(source,relative) in enumerate(entries):
        for other,other_relative in entries[:i]:
            if source==other or source.is_relative_to(other) or other.is_relative_to(source):
                raise ValueError('Overlapping source stores')
            if relative==other_relative or relative.is_relative_to(other_relative) or other_relative.is_relative_to(relative):
                raise ValueError('Overlapping destination stores')
    pending = []
    for source, relative in entries:
        destination = target / relative
        no_links(destination)
        if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
            print(f'跳过已有内容的目标：{destination}；旧目录保留：{source}', file=sys.stderr)
            skipped_stores.add((source, relative))
        else:
            pending.append((source, relative))
    entries = pending
    if not entries:
        print('没有待迁移的目录。')
        return
    snapshots={str(src):files(src, require_idle=apply) for src,_ in entries}
    print(json.dumps({'destination':str(target),'stores':[{'source':str(s),'destination':str(target/r),'files':len(snapshots[str(s)])} for s,r in entries]},ensure_ascii=False,indent=2))
    if not apply:return
    if os.name!='nt':raise ValueError('执行迁移需要 Windows 文件占用检查。')
    target.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.storage-migration-',dir=target.parent))
    journal={'target':str(target),'backups':[],'activated':False}
    journal_path=stage/'migration.json'
    installed = []
    empty_targets = []
    try:
        for source,relative in entries:
            dest=stage/relative
            shutil.copytree(source,dest)
            if files(source)!=snapshots[str(source)] or files(dest)!=snapshots[str(source)]:
                raise ValueError(f'Source changed or copy differs: {source}')
            for db in [*dest.rglob('*.db'),*dest.rglob('*.sqlite3')]:
                connection=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)
                try:
                    if connection.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError(f'Invalid database: {db}')
                finally:connection.close()
        # Optional application-owned hook only changes the staged copy.
        for hook in config.get('hooks',[]):
            if ((base / hook['source']).resolve(), Path(hook['store'])) in skipped_stores:
                continue
            script=(base/hook['script']).resolve()
            subprocess.run([sys.executable,'-B',str(script),'--staged',str(stage/ hook['store']),'--old',str((base/hook['source']).resolve()),'--new',str(target/hook['store'])],check=True)
        for source,relative in entries:
            if files(source, require_idle=True)!=snapshots[str(source)]:raise ValueError('Source changed during preparation')
        for source,relative in entries:
            destination = target / relative
            no_links(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                destination.rmdir()  # Fails if files appeared after the plan.
                empty_targets.append(destination)
            (stage / relative).rename(destination)  # Windows refuses an existing destination.
            installed.append(relative)
            backup=source.with_name(source.name+'.pre-central-'+uuid.uuid4().hex[:12])
            source.rename(backup)
            journal['backups'].append({'source':str(source),'backup':str(backup),'destination':str(destination)})
            journal_path.write_text(json.dumps(journal,ensure_ascii=False,indent=2),encoding='utf-8')
        journal['activated']=True
        journal_path.write_text(json.dumps(journal,ensure_ascii=False,indent=2),encoding='utf-8')
        report = target / 'migration.json'
        if report.exists():
            report = target / f'migration-{uuid.uuid4().hex}.json'
        journal_path.rename(report)
    except BaseException:
        for item in reversed(journal['backups']):
            if not Path(item['source']).exists():Path(item['backup']).rename(item['source'])
        for relative in reversed(installed):
            (target / relative).rename(stage / relative)
        for destination in empty_targets:
            destination.mkdir(exist_ok=True)
        # Keep staged evidence for recovery; never delete business data here.
        raise
    for directory, _, _ in os.walk(stage, topdown=False):
        Path(directory).rmdir()
    print(f'迁移完成，记录已保存到 {report}')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('--apply',action='store_true');a=p.parse_args()
    run(a.manifest,a.apply)
