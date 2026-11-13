"""Portal packaging tests; no business services or Docker are started."""
import email.message
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "package-windows-runtime.py"
SPEC = importlib.util.spec_from_file_location("package_windows_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class Distribution:
    def __init__(self, root, name, version="1.0", requires=(), extras=(), files=()):
        self.root = root
        self.name = name
        self.version = version
        self.requires = list(requires)
        self.files = [PurePosixPath(file) for file in files]
        self.metadata = email.message.Message()
        self.metadata["Name"] = name
        for extra in extras:
            self.metadata["Provides-Extra"] = extra

    def locate_file(self, file):
        return self.root / str(file)

    def read_text(self, name):
        return None


class PortableRuntimeTest(unittest.TestCase):
    def test_requirement_parsing_validates_markers_and_rejects_url_or_pip_options(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            file = Path(directory) / "requirements.txt"
            file.write_text("# Dependencies\nexample>=1,\\\n <3 # comment\nmissing; python_version<'1'\n", encoding="utf-8")
            requirements = runtime.requirements_from_files([file])
            self.assertEqual([item.name for item in requirements], ["example"])
            self.assertEqual(str(requirements[0].specifier), "<3,>=1")
            for invalid in ["example @ https://private.invalid/path", "-r private.txt", "--index-url https://private.invalid"]:
                file.write_text(invalid, encoding="utf-8")
                with self.assertRaises(runtime.RuntimePackageError):
                    runtime.requirements_from_files([file])

    def test_dependency_closure_checks_versions_extras_markers_and_missing_packages(self):
        distributions = {
            "example": Distribution(Path("unused"), "example", requires=["core>=1", "extra-dep; extra=='report'", "other-os; sys_platform=='impossible'"], extras=["report"]),
            "core": Distribution(Path("unused"), "core", version="2.0"),
            "extra-dep": Distribution(Path("unused"), "extra-dep"),
        }

        def lookup(name):
            if name not in distributions:
                raise runtime.metadata.PackageNotFoundError(name)
            return distributions[name]

        requirements = [runtime.Requirement("example[report]>=1")]
        self.assertEqual(set(runtime.resolve_distributions(requirements, lookup)), {"example", "core", "extra-dep"})
        for declaration in ["example>4", "example[unknown]", "missing"]:
            with self.assertRaises(runtime.RuntimePackageError):
                runtime.resolve_distributions([runtime.Requirement(declaration)], lookup)

    def test_dependency_copy_keeps_resources_licenses_and_metadata_but_skips_machine_files(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            root = Path(directory)
            source, output = root / "source", root / "output"
            files = {
                "example/__init__.py": "VALUE=42\n",
                "example/resources/schema.json": "{}",
                "example/.hidden/private.txt": "not needed",
                "example/__pycache__/temp.pyc": "bytecode",
                "example-1.0.dist-info/LICENSE": "license text",
                "example-1.0.dist-info/METADATA": "Name: example\nVersion: 1.0\n",
                "example-1.0.dist-info/direct_url.json": json.dumps({"url": "file:///private/build/path"}),
            }
            for name, text in files.items():
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(text, encoding="utf-8")
            output.mkdir()
            distribution = Distribution(source, "example", files=files)
            imports = runtime.copy_distributions({"example": distribution}, output, {})
            self.assertEqual(imports, {"example"})
            copied = {file.relative_to(output / "Lib" / "site-packages").as_posix() for file in output.rglob("*") if file.is_file()}
            self.assertEqual(copied, {"example/__init__.py", "example/resources/schema.json", "example-1.0.dist-info/LICENSE", "example-1.0.dist-info/METADATA"})

    def test_dependency_rejects_path_injection_and_records_outside_site_packages(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "inject.pth").write_text("import private_machine_hook\n", encoding="utf-8")
            for record in ["inject.pth", "../private/config.json", "C:/private/data.json", "example/bad."]:
                output = root / ("output-" + str(len(list(root.glob("output-*")))))
                output.mkdir()
                distribution = Distribution(source, "example", files=[record])
                with self.assertRaises(runtime.RuntimePackageError):
                    runtime.copy_distributions({"example": distribution}, output, {})

    def test_windows_names_and_case_collisions_are_rejected(self):
        for name in ["example/CON.txt", "example/name.", "example/trail ", "../outside", "example/.private", "example/a:b"]:
            self.assertFalse(runtime.safe_relative(PurePosixPath(name)), name)
        self.assertTrue(runtime.safe_relative(PurePosixPath("numpy.libs/runtime.dll")))
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            root = Path(directory)
            first, second = root / "a", root / "b"
            first.write_text("a", encoding="utf-8")
            second.write_text("b", encoding="utf-8")
            output = root / "output"
            output.mkdir()
            copied = {}
            runtime.copy_file(first, output / "same.py", copied, output)
            with self.assertRaises(runtime.RuntimePackageError):
                runtime.copy_file(second, output / "SAME.py", copied, output)

    def test_app_root_bootstrap_is_explicit_and_rejects_invalid_paths(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            before = list(runtime.sys.path)
            bytecode = runtime.sys.dont_write_bytecode
            try:
                with patch.dict(os.environ, {"PLANHUB_PYTHON_APP_ROOT": directory}):
                    exec(runtime.APP_BOOTSTRAP, {})
                    self.assertEqual(Path(runtime.sys.path[0]), Path(directory).resolve())
                for value in ["relative/path", str(Path(directory) / "missing")]:
                    with patch.dict(os.environ, {"PLANHUB_PYTHON_APP_ROOT": value}):
                        with self.assertRaises(SystemExit):
                            exec(runtime.APP_BOOTSTRAP, {})
            finally:
                runtime.sys.path[:] = before
                runtime.sys.dont_write_bytecode = bytecode

    def test_dependency_probe_clears_inherited_python_and_app_paths(self):
        with patch.dict(os.environ, {"PYTHONPATH": "private", "PYTHONHOME": "private", "VIRTUAL_ENV": "private", "PLANHUB_PYTHON_APP_ROOT": "private"}):
            environment = runtime.isolated_environment(Path("runtime"))
        self.assertNotIn("PYTHONPATH", environment)
        self.assertNotIn("PYTHONHOME", environment)
        self.assertNotIn("VIRTUAL_ENV", environment)
        self.assertNotIn("PLANHUB_PYTHON_APP_ROOT", environment)

    def test_stdlib_zip_preserves_bytes_and_bootstraps_without_cache_directories(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-test-") as directory:
            root = Path(directory)
            source, output = root / "Lib", root / "output"
            source.mkdir()
            output.mkdir()
            files = {"codecs.py": "VALUE = 42\n", "encodings/__init__.py": "# encoding\n", "__pycache__/ignored.pyc": "cache", "site-packages/private.py": "private", "test/not_runtime.py": "test"}
            for name, text in files.items():
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(text, encoding="utf-8")
            archive = runtime.copy_stdlib(source, output)
            with zipfile.ZipFile(output / archive) as file:
                self.assertEqual(set(file.namelist()), {"codecs.py", "encodings/__init__.py", "sitecustomize.py"})
                self.assertEqual(file.read("codecs.py"), (source / "codecs.py").read_bytes())
                self.assertIn(b"sys.dont_write_bytecode = True", file.read("sitecustomize.py"))


if __name__ == "__main__":
    unittest.main()
