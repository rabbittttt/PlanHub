from contextlib import closing
import importlib.util,json,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('migration',Path(__file__).resolve().parents[1]/'scripts/migrate-storage.py')
migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
class MigrationTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.source=self.root/'old';self.source.mkdir();(self.source/'value.txt').write_text('saved')
  with closing(sqlite3.connect(self.source/'test.sqlite3')) as c, c:c.execute('create table saved(value)');c.execute('insert into saved values(42)')
  self.manifest=self.root/'plan.json';self.manifest.write_text(json.dumps({'destination':'new','stores':[{'source':'old','destination':'database/app'}]}))
 def test_plan_does_not_change_data(self):
  before=migration.files(self.source);migration.run(self.manifest)
  self.assertEqual(migration.files(self.source),before);self.assertFalse((self.root/'new').exists())
 def test_apply_preserves_database_and_recovery_copy(self):
  before=migration.files(self.source)
  migration.run(self.manifest,True)
  destination=self.root/'new/database/app'
  self.assertEqual(migration.files(destination),before);self.assertFalse(self.source.exists())
  journal=json.loads((self.root/'new/migration.json').read_text())
  self.assertTrue(journal['activated']);self.assertEqual(migration.files(Path(journal['backups'][0]['backup'])),before)
 def test_existing_root_migrates_only_available_destinations(self):
  target=self.root/'new'
  (target/'database/app').mkdir(parents=True)
  (target/'database/occupied').mkdir()
  (target/'database/occupied/current').write_text('live')
  (target/'shared').mkdir()
  (target/'shared/orders.xlsx').write_bytes(b'original')
  (target/'migration.json').write_text('previous journal')
  occupied=self.root/'other';occupied.mkdir();(occupied/'old').write_text('legacy')
  config=json.loads(self.manifest.read_text())
  config['stores'].append({'source':'other','destination':'database/occupied'})
  config['hooks']=[{'source':'other','store':'database/occupied','script':'unused.py'}]
  self.manifest.write_text(json.dumps(config))
  before=migration.files(target)
  migration.run(self.manifest)
  self.assertEqual(migration.files(target),before)
  with patch.object(migration.subprocess,'run') as calls:
   migration.run(self.manifest,True)
   migration.run(self.manifest,True)
  calls.assert_not_called()
  for name,digest in before.items():self.assertEqual(migration.files(target)[name],digest)
  self.assertEqual((target/'database/app/value.txt').read_text(),'saved')
  self.assertEqual((occupied/'old').read_text(),'legacy')
  self.assertEqual(len(list(target.glob('migration-*.json'))),1)

 def test_activation_failure_restores_only_this_runs_stores(self):
  first=self.root/'new/database/app';first.mkdir(parents=True)
  other=self.root/'other';other.mkdir()
  config=json.loads(self.manifest.read_text())
  config['stores'].append({'source':'other','destination':'database/second'})
  self.manifest.write_text(json.dumps(config))
  second=first.parent.resolve()/'second'
  rename=Path.rename
  def inject(path,destination):
   if destination==second:
    second.mkdir();(second/'appeared').write_text('keep')
    raise FileExistsError(str(second))
   return rename(path,destination)
  with patch.object(Path,'rename',inject):
   with self.assertRaises(FileExistsError):migration.run(self.manifest,True)
  self.assertEqual(list(first.iterdir()),[])
  self.assertEqual((self.source/'value.txt').read_text(),'saved')
  self.assertTrue(other.is_dir())
  self.assertEqual((second/'appeared').read_text(),'keep')
 def test_missing_store_and_its_hook_are_skipped(self):
  config=json.loads(self.manifest.read_text())
  config['stores'].insert(0,{'source':'absent','destination':'database/quicklook'})
  config['hooks']=[{'script':'absent-hook.py','source':'absent','store':'database/quicklook'}]
  self.manifest.write_text(json.dumps(config))
  migration.run(self.manifest)
  with patch.object(migration.subprocess,'run') as calls:
   migration.run(self.manifest,True)
  calls.assert_not_called()
  self.assertEqual((self.root/'new/database/app/value.txt').read_text(),'saved')
  self.assertFalse((self.root/'new/database/quicklook').exists())
 def test_all_missing_creates_nothing(self):
  self.source.rename(self.root/'elsewhere')
  with patch.object(migration.subprocess,'run') as calls:migration.run(self.manifest,True)
  calls.assert_not_called()
  self.assertFalse((self.root/'new').exists())
 def test_file_in_place_of_directory_fails(self):
  self.source.rename(self.root/'elsewhere')
  self.source.write_text('saved')
  with self.assertRaises(NotADirectoryError):migration.run(self.manifest,True)

 def test_open_database_blocks_only_while_the_file_is_in_use(self):
  database=self.source/'test.sqlite3'
  with database.open('rb'):
   with self.assertRaisesRegex(ValueError,'test.sqlite3'):migration.run(self.manifest,True)
   self.assertFalse((self.root/'new').exists())
  # This test process remains alive while the real command migrates the fixtures.
  result=subprocess.run([sys.executable,'-B',migration.__file__,str(self.manifest),'--apply'],
                        capture_output=True)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertTrue((self.root/'new/database/app/test.sqlite3').exists())
