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
