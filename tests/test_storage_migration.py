from contextlib import closing
import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
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
  with patch.object(migration.subprocess,'run',return_value=SimpleNamespace(stdout='[]')):migration.run(self.manifest,True)
  destination=self.root/'new/database/app'
  self.assertEqual(migration.files(destination),before);self.assertFalse(self.source.exists())
  journal=json.loads((self.root/'new/migration.json').read_text())
  self.assertTrue(journal['activated']);self.assertEqual(migration.files(Path(journal['backups'][0]['backup'])),before)
 def test_existing_target_is_never_overwritten(self):
  (self.root/'new').mkdir()
  with self.assertRaises(ValueError):migration.run(self.manifest,True)
  self.assertTrue(self.source.exists())
 def test_missing_store_and_its_hook_are_skipped(self):
  config=json.loads(self.manifest.read_text())
  config['stores'].insert(0,{'source':'absent','destination':'database/quicklook'})
  config['hooks']=[{'script':'absent-hook.py','source':'absent','store':'database/quicklook'}]
  self.manifest.write_text(json.dumps(config))
  migration.run(self.manifest)
  with patch.object(migration.subprocess,'run',return_value=SimpleNamespace(stdout='[]')) as calls:
   migration.run(self.manifest,True)
  calls.assert_called_once()
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
