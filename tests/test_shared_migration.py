import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('shared_migration',Path(__file__).resolve().parents[1]/'scripts/migrate-shared.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SharedMigrationTests(unittest.TestCase):
    def fixture(self, folder):
        root=Path(folder);source=root/'old';destination=root/'state/shared';quicklook=root/'state/database/quicklook'
        source.mkdir();(source/'orders.xlsx').write_bytes(b'original workbook')
        (destination/'原始销量').mkdir(parents=True)
        quicklook.mkdir(parents=True);(quicklook/'workspace.json').write_text('{}')
        hook=root/'hook.py';hook.write_text('# fixture hook')
        return source,destination,quicklook,hook,root

    def test_dry_run_is_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder);module.run(*args)
            self.assertTrue((args[0]/'orders.xlsx').exists());self.assertFalse((args[1]/'orders.xlsx').exists())
            self.assertFalse((args[1].parent/'backups').exists())

    def test_missing_old_shared_folder_leaves_current_data_alone(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder)
            args[0].rename(args[4]/'elsewhere')
            with patch.object(module.subprocess,'run') as calls:
                module.run(*args,apply=True)
            calls.assert_not_called()
            self.assertTrue((args[1]/'原始销量').is_dir())
            self.assertFalse((args[1].parent/'backups').exists())

    def test_apply_preserves_files_and_places_originals_in_recovery_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder)
            legacy=args[0]/'catalog.pre-central-old';legacy.mkdir();(legacy/'keep.db').write_bytes(b'recovery')
            module.run(*args,apply=True)
            self.assertFalse(args[0].exists());self.assertEqual((args[1]/'orders.xlsx').read_bytes(),b'original workbook')
            self.assertTrue((args[1]/'原始销量').is_dir());self.assertTrue((args[2]/'workspace.json').exists())
            backups=list((args[1].parent/'backups').glob('shared-migration-*'))
            self.assertEqual(len(backups),1);self.assertEqual((backups[0]/'shared/orders.xlsx').read_bytes(),b'original workbook')
            self.assertTrue(json.loads((backups[0]/'migration.json').read_text())['activated'])
            self.assertFalse((args[1]/legacy.name).exists())
            self.assertEqual((backups[0]/'shared'/legacy.name/'keep.db').read_bytes(),b'recovery')

    def test_hook_failure_keeps_original_sources_and_state(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder)
            with patch.object(module.subprocess,'run',side_effect=RuntimeError('hook failed')):
                with self.assertRaisesRegex(RuntimeError,'hook failed'):module.run(*args,apply=True)
            self.assertTrue((args[0]/'orders.xlsx').exists());self.assertEqual((args[2]/'workspace.json').read_text(),'{}')
            self.assertFalse((args[1]/'orders.xlsx').exists())

    def test_open_shared_input_or_quicklook_state_identifies_file_before_moving(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder)
            for file in (args[0]/'orders.xlsx',args[2]/'workspace.json'):
                with file.open('rb'),self.assertRaisesRegex(ValueError,file.name):
                    module.run(*args,apply=True)
                self.assertTrue(args[0].is_dir())
                self.assertFalse((args[1].parent/'backups').exists())

    def test_existing_destination_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            args=self.fixture(folder);(args[1]/'important.xlsx').write_bytes(b'keep')
            with self.assertRaisesRegex(ValueError,'never merge'):module.run(*args,apply=True)
            self.assertEqual((args[1]/'important.xlsx').read_bytes(),b'keep')
