"""Offline runtime compatibility tests with synthetic distribution metadata only."""
import email.message
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check-windows-runtime.py"
SPEC = importlib.util.spec_from_file_location("check_windows_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class Distribution:
    def __init__(self, version, requires=(), extras=(), python=None):
        self.version = version
        self.requires = list(requires)
        self.metadata = email.message.Message()
        if python:
            self.metadata["Requires-Python"] = python
        for extra in extras:
            self.metadata["Provides-Extra"] = extra


class RuntimeCompatibilityTest(unittest.TestCase):
    def test_runtime_metadata_requires_the_selected_interpreter_and_application_bootstrap(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-check-") as directory:
            root = Path(directory)
            executable = root / "python.exe"
            executable.write_text("synthetic interpreter, never executed", encoding="utf-8")
            summary = {"schemaVersion": 1, "platform": "win32-x64", "implementation": "CPython", "pythonVersion": "3.12.0", "executable": "python.exe", "applicationRootEnvironment": "PLANHUB_PYTHON_APP_ROOT"}
            file = root / "runtime.json"
            file.write_text(json.dumps(summary), encoding="utf-8")
            with patch.object(runtime.sys, "platform", "win32"), patch.object(runtime.sys, "executable", str(executable)), patch.object(runtime.sys, "version_info", (3, 12)), patch.object(runtime.sys, "maxsize", 2**63-1), patch.object(runtime.platform, "machine", return_value="AMD64"), patch.object(runtime.platform, "python_implementation", return_value="CPython"), patch.object(runtime.platform, "python_version", return_value="3.12.0"):
                runtime.check_runtime(root)
                del summary["applicationRootEnvironment"]
                file.write_text(json.dumps(summary), encoding="utf-8")
                with self.assertRaisesRegex(runtime.RuntimeCompatibilityError, "bootstrap"):
                    runtime.check_runtime(root)

    def test_requirement_markers_comments_continuation_and_unsupported_semantics(self):
        with tempfile.TemporaryDirectory(prefix="planhub-runtime-check-") as directory:
            file = Path(directory) / "requirements.txt"
            file.write_text("example>=1,\\\n<3 # comment\nmissing; sys_platform=='impossible'\n", encoding="utf-8")
            parsed = runtime.requirements_from_files([file])
            self.assertEqual([item.name for item in parsed], ["example"])
            self.assertEqual(str(parsed[0].specifier), "<3,>=1")
            for declaration in ["-r other.txt", "--find-links some/path", "example @ https://invalid.example/pkg", "example>=1\\"]:
                file.write_text(declaration, encoding="utf-8")
                with self.assertRaises(runtime.RuntimeCompatibilityError):
                    runtime.requirements_from_files([file])

    def test_metadata_closure_checks_versions_extras_python_and_conditional_dependencies(self):
        distributions = {
            "example": Distribution("2.0", requires=["core>=1", "report; extra=='report'", "other; sys_platform=='impossible'"], extras=["report"]),
            "core": Distribution("1.5"),
            "report": Distribution("1.0"),
        }
        def lookup(name):
            if name not in distributions:
                raise runtime.metadata.PackageNotFoundError(name)
            return distributions[name]
        checked = runtime.check_distributions([runtime.Requirement("example[report]>=2")], lookup, "3.12.0")
        self.assertEqual(checked, {"core": "1.5", "example": "2.0", "report": "1.0"})
        for declaration in ["example>=3", "example[missing]", "missing"]:
            with self.assertRaises(runtime.RuntimeCompatibilityError):
                runtime.check_distributions([runtime.Requirement(declaration)], lookup, "3.12.0")
        distributions["core"] = Distribution("1.5", python=">=4")
        with self.assertRaisesRegex(runtime.RuntimeCompatibilityError, "Python version"):
            runtime.check_distributions([runtime.Requirement("example")], lookup, "3.12.0")
        distributions["core"] = Distribution("1.5", requires=["remote @ https://invalid.example/pkg"])
        with self.assertRaisesRegex(runtime.RuntimeCompatibilityError, "offline"):
            runtime.check_distributions([runtime.Requirement("example")], lookup, "3.12.0")


if __name__ == "__main__":
    unittest.main()
