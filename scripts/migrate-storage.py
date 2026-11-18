"""Move stopped application stores to a single root; default is a read-only plan."""
import argparse, hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile, uuid
import stat
from pathlib import Path

def no_links(path):
    for node in [path,*path.parents]:
        if node.is_symlink() or (hasattr(node,'is_junction') and node.is_junction()):
            raise ValueError(f'Linked migration path: {node}')

def files(root):
    result={}
    for p in [root, *root.rglob('*')]:
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):
            raise ValueError(f'Linked migration source: {p}')
        if p.is_file():
            result[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
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
        if relative.is_absolute() or '..' in relative.parts:raise ValueError('Invalid destination')
        if not has_source_directory(source):
            skipped_stores.add((source, relative))
            continue
        if target==source or target.is_relative_to(source) or source.is_relative_to(target):
            raise ValueError('Source and destination overlap')
        entries.append((source,relative))
    if not entries:
        print('没有需要迁移的旧数据目录。')
        return
    if target.exists():raise ValueError(f'Destination exists; never merge or overwrite: {target}')
    for i,(source,relative) in enumerate(entries):
        for other,other_relative in entries[:i]:
            if source==other or source.is_relative_to(other) or other.is_relative_to(source):
                raise ValueError('Overlapping source stores')
            if relative==other_relative or relative.is_relative_to(other_relative) or other_relative.is_relative_to(relative):
                raise ValueError('Overlapping destination stores')
    snapshots={str(src):files(src) for src,_ in entries}
    print(json.dumps({'destination':str(target),'stores':[{'source':str(s),'destination':str(target/r),'files':len(snapshots[str(s)])} for s,r in entries]},ensure_ascii=False,indent=2))
    if not apply:return
    if os.name!='nt':raise ValueError('Apply currently requires Windows stopped-process verification')
    # Refuse any Python application process except this migration. No process is terminated.
    command=r"Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^python(w)?\.exe$'} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],capture_output=True,text=True,check=True)
    processes=json.loads(result.stdout or '[]')
    if isinstance(processes,dict):processes=[processes]
    for process in processes:
        if process['ProcessId']!=os.getpid() and 'migrate-storage.py' not in (process.get('CommandLine') or ''):
            raise ValueError('Stop Python business services before migration; no process was stopped.')
    target.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.storage-migration-',dir=target.parent))
    journal={'target':str(target),'backups':[],'activated':False}
    journal_path=stage/'migration.json'
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
            if files(source)!=snapshots[str(source)]:raise ValueError('Source changed during preparation')
        for source,_ in entries:
            backup=source.with_name(source.name+'.pre-central-'+uuid.uuid4().hex[:12])
            source.rename(backup)
            journal['backups'].append({'source':str(source),'backup':str(backup)})
            journal_path.write_text(json.dumps(journal,ensure_ascii=False,indent=2),encoding='utf-8')
        stage.rename(target)
        journal['activated']=True
        (target/'migration.json').write_text(json.dumps(journal,ensure_ascii=False,indent=2),encoding='utf-8')
    except BaseException:
        if not stage.exists() and target.exists():target.rename(stage)
        for item in reversed(journal['backups']):
            if not Path(item['source']).exists():Path(item['backup']).rename(item['source'])
        # Keep staged evidence for recovery; never delete business data here.
        raise

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('--apply',action='store_true');a=p.parse_args()
    run(a.manifest,a.apply)
