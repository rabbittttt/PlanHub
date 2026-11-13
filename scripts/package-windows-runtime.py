"""Assemble an app-local Windows CPython runtime from the build environment.

No installer, pip operation, network access, or virtual-environment relocation is
performed. Only installed distributions required by the release payloads travel
with the interpreter. Business application modules are never imported here.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import sysconfig
import tempfile
import zipfile

try:
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
    from packaging.utils import canonicalize_name
except ImportError:
    try:
        from pip._vendor.packaging.requirements import Requirement
        from pip._vendor.packaging.specifiers import SpecifierSet
        from pip._vendor.packaging.utils import canonicalize_name
    except ImportError:
        raise SystemExit("Build Python needs packaging (or pip) to verify installed dependency versions")


class RuntimePackageError(Exception):
    pass


STDLIB_PROBE = {"asyncio", "bz2", "ctypes", "decimal", "hashlib", "http.server", "lzma", "sqlite3", "ssl", "uuid", "zoneinfo"}


# This is portal runtime infrastructure, never written into a child payload.
# The launcher supplies its already-validated immutable payload directory.
# Keeping it in the service environment also supports original child workers
# that invoke `sys.executable script.py` or Python `-c` from a Node finalizer.
APP_BOOTSTRAP = '''"""Restore the selected release's import root for owned Python workers."""
import sys
sys.dont_write_bytecode = True
import os
import stat

_root = os.environ.get("PLANHUB_PYTHON_APP_ROOT")
if _root:
    if not os.path.isabs(_root) or not os.path.isdir(_root):
        raise SystemExit("PLANHUB_PYTHON_APP_ROOT must be an existing absolute directory")
    _current = os.path.abspath(_root)
    while True:
        _details = os.lstat(_current)
        if stat.S_ISLNK(_details.st_mode) or getattr(_details, "st_file_attributes", 0) & 0x400:
            raise SystemExit("Linked Python application roots are not allowed")
        _parent = os.path.dirname(_current)
        if _parent == _current:
            break
        _current = _parent
    _root = os.path.realpath(_root)
    sys.path.insert(0, _root)
    # Original application workers may execute nested scripts directly. Restore
    # Python's normal script-directory precedence, bounded to this release.
    if sys.argv and sys.argv[0] and not sys.argv[0].startswith("-"):
        _script = os.path.abspath(sys.argv[0])
        _real_script = os.path.realpath(_script)
        try:
            _inside = os.path.normcase(os.path.commonpath([_root, _real_script])) == os.path.normcase(_root)
        except ValueError:
            _inside = False
        if _inside and os.path.isfile(_script):
            _current = _script
            while True:
                _details = os.lstat(_current)
                if stat.S_ISLNK(_details.st_mode) or getattr(_details, "st_file_attributes", 0) & 0x400:
                    raise SystemExit("Linked Python application scripts are not allowed")
                _parent = os.path.dirname(_current)
                if _parent == _current:
                    break
                _current = _parent
            _script_root = os.path.dirname(_real_script)
            if os.path.normcase(_script_root) != os.path.normcase(_root):
                sys.path.insert(0, _script_root)
'''


def no_link(path: Path) -> None:
    """Check ancestors as well as the leaf before reading or writing a path."""
    current = path.absolute()
    while True:
        try:
            attributes = current.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISLNK(attributes.st_mode) or getattr(attributes, "st_file_attributes", 0) & 0x400:
                raise RuntimePackageError(f"Linked runtime path is not allowed: {current}")
        if current.parent == current:
            return
        current = current.parent


def requirements_from_files(files: list[Path]) -> list[Requirement]:
    requirements = []
    for file in files:
        no_link(file)
        continuation = ""
        for line in file.read_text(encoding="utf-8-sig").splitlines():
            text = re.split(r"\s+#", line.strip(), maxsplit=1)[0].strip()
            if not text or text.startswith("#"):
                continue
            if text.endswith("\\"):
                continuation += text[:-1] + " "
                continue
            text = continuation + text
            continuation = ""
            try:
                requirement = Requirement(text)
            except Exception as error:
                raise RuntimePackageError(f"Unsupported requirement in {file.name}: {text}") from error
            if requirement.url:
                raise RuntimePackageError(f"URL requirements are not portable: {requirement.name}")
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""}):
                requirements.append(requirement)
        if continuation:
            raise RuntimePackageError(f"Unfinished requirement line in {file.name}")
    return requirements


def resolve_distributions(requirements: list[Requirement], lookup=metadata.distribution):
    """Resolve installed versions, markers and extras without contacting an index."""
    selected = {}
    extras = {}
    processed = {}
    pending = list(requirements)
    while pending:
        requirement = pending.pop()
        name = canonicalize_name(requirement.name)
        if requirement.url:
            raise RuntimePackageError(f"URL dependency is not portable: {name}")
        if name not in selected:
            try:
                selected[name] = lookup(name)
            except metadata.PackageNotFoundError as error:
                raise RuntimePackageError(f"Build Python is missing dependency: {name}") from error
        distribution = selected[name]
        if not requirement.specifier.contains(distribution.version, prereleases=True):
            raise RuntimePackageError(f"Build Python has {name} {distribution.version}; required {requirement.specifier}")
        python_rule = distribution.metadata.get("Requires-Python")
        if python_rule and not SpecifierSet(python_rule).contains(platform.python_version(), prereleases=True):
            raise RuntimePackageError(f"{name} does not support the build Python version")
        requested = {canonicalize_name(extra) for extra in requirement.extras}
        available = {canonicalize_name(extra) for extra in distribution.metadata.get_all("Provides-Extra", [])}
        if not requested <= available:
            raise RuntimePackageError(f"Installed {name} does not provide extras: {', '.join(sorted(requested - available))}")
        extras.setdefault(name, set()).update(requested)
        context = frozenset(extras[name])
        if processed.get(name) == context:
            continue
        processed[name] = context
        for declaration in distribution.requires or []:
            dependency = Requirement(declaration)
            if dependency.marker is None or any(dependency.marker.evaluate({"extra": extra}) for extra in {"", *context}):
                pending.append(dependency)
    return selected


def safe_relative(relative: PurePosixPath) -> bool:
    for part in relative.parts:
        if not part or part.startswith(".") or part.endswith((".", " ")) or re.search(r'[<>:"\\|?*\x00-\x1f]', part):
            return False
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part):
            return False
    return not relative.is_absolute()


def excluded(relative: PurePosixPath) -> bool:
    return (
        "__pycache__" in relative.parts
        or relative.suffix.lower() in {".pyc", ".pyo"}
        or relative.name == "direct_url.json"
        or any(part.startswith(".") and part != ".." for part in relative.parts)
    )


def copy_file(source: Path, destination: Path, copied: dict[str, Path], output: Path) -> None:
    no_link(source)
    no_link(destination)
    if not source.is_file():
        raise RuntimePackageError(f"Runtime file is missing: {source}")
    key = str(destination.relative_to(output)).casefold()
    if key in copied:
        # Namespace packages may have a shared file, but not conflicting bytes.
        if source.read_bytes() != copied[key].read_bytes():
            raise RuntimePackageError(f"Conflicting runtime files: {destination.relative_to(output)}")
        return
    if destination.exists():
        raise RuntimePackageError(f"Runtime destination collision: {destination.relative_to(output)}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied[key] = source


def copy_stdlib(source: Path, output: Path) -> str:
    """zipimport keeps early interpreter startup from writing bytecode caches."""
    archive_name = f"python{sys.version_info.major}{sys.version_info.minor}.zip"
    archive = output / archive_name
    if archive.exists():
        raise RuntimePackageError("Standard-library archive destination exists")
    no_link(source)
    if not source.is_dir():
        raise RuntimePackageError("Build Python has no Lib directory")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for current, directories, files in os.walk(source, followlinks=False):
            current_path = Path(current)
            no_link(current_path)
            kept = []
            for name in directories:
                child = current_path / name
                no_link(child)
                relative = child.relative_to(source)
                if name == "__pycache__" or name.startswith(".") or relative.parts[0] in {"site-packages", "test", "ensurepip", "idlelib"}:
                    continue
                kept.append(name)
            directories[:] = kept
            for name in files:
                relative = PurePosixPath((current_path / name).relative_to(source).as_posix())
                if excluded(relative):
                    continue
                if relative.as_posix() in {"sitecustomize.py", "usercustomize.py"}:
                    raise RuntimePackageError("Build Python contains a machine-specific site customization")
                if not safe_relative(relative):
                    raise RuntimePackageError(f"Nonportable standard-library filename: {relative}")
                no_link(current_path / name)
                target.write(current_path / name, relative.as_posix())
        target.writestr("sitecustomize.py", APP_BOOTSTRAP)
    return archive_name


def copy_base(base: Path, output: Path, copied: dict[str, Path]) -> None:
    no_link(base)
    major, minor = sys.version_info[:2]
    essential = ["python.exe", f"python{major}{minor}.dll", "python3.dll", "LICENSE.txt"]
    for name in essential:
        copy_file(base / name, output / name, copied, output)
    for name in ["pythonw.exe", "vcruntime140.dll", "vcruntime140_1.dll"]:
        if (base / name).is_file():
            copy_file(base / name, output / name, copied, output)
    # tkinter's DLLs need the bundled Tcl resources; keep them together.
    copy_stdlib(base / "Lib", output)
    for directory in ["DLLs", "tcl"]:
        source = base / directory
        if not source.is_dir():
            if directory != "tcl":
                raise RuntimePackageError(f"Build Python has no {directory} directory")
            continue
        for current, directories, files in os.walk(source, followlinks=False):
            current_path = Path(current)
            no_link(current_path)
            kept = []
            for name in directories:
                child = current_path / name
                no_link(child)
                relative = child.relative_to(source)
                if name == "__pycache__" or name.startswith("."):
                    continue
                kept.append(name)
            directories[:] = kept
            for name in files:
                relative = PurePosixPath((current_path / name).relative_to(source).as_posix())
                if excluded(relative):
                    continue
                if not safe_relative(relative):
                    raise RuntimePackageError(f"Nonportable standard-library filename: {relative}")
                copy_file(current_path / name, output / directory / Path(relative), copied, output)


def import_names(distribution) -> set[str]:
    declarations = distribution.read_text("top_level.txt")
    if declarations:
        return {line.strip() for line in declarations.splitlines() if line.strip().isidentifier()}
    names = set()
    for record in distribution.files or []:
        parts = PurePosixPath(str(record).replace("\\", "/")).parts
        if not parts or parts[0].startswith("."):
            continue
        top = parts[0]
        if len(parts) > 1 and top.isidentifier() and Path(parts[-1]).suffix in {".py", ".pyd"}:
            names.add(top)
        elif len(parts) == 1 and Path(top).suffix in {".py", ".pyd"}:
            candidate = top.split(".")[0]
            if candidate.isidentifier():
                names.add(candidate)
    return names


def copy_distributions(distributions, output: Path, copied: dict[str, Path]) -> set[str]:
    site_packages = output / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    imports = set()
    for name, distribution in sorted(distributions.items()):
        source_root = Path(distribution.locate_file("")).absolute()
        no_link(source_root)
        files = distribution.files
        if not files:
            raise RuntimePackageError(f"Installed distribution has no file manifest: {name}")
        imports.update(import_names(distribution))
        for record in files:
            relative = PurePosixPath(str(record).replace("\\", "/"))
            target_root = site_packages
            if ".." in relative.parts:
                # Wheel console-script launchers embed the build interpreter's
                # absolute path. Services use `python script.py`, never these.
                source = Path(distribution.locate_file(record)).absolute()
                no_link(source)
                try:
                    installed_relative = source.resolve().relative_to(Path(sys.prefix).resolve())
                except ValueError as error:
                    raise RuntimePackageError(f"Installed dependency stores data outside site-packages: {name}: {relative}") from error
                if installed_relative.parts[0].casefold() == "scripts":
                    continue
                # Preserve wheel-owned auxiliary data using the same prefix-
                # relative layout (e.g. Plotly/PyDeck Jupyter resources).
                if installed_relative.parts[0].casefold() not in {"share", "etc"}:
                    raise RuntimePackageError(f"Unsupported external dependency data: {name}: {relative}")
                relative = PurePosixPath(installed_relative.as_posix())
                target_root = output
            if excluded(relative):
                continue
            if not safe_relative(relative):
                raise RuntimePackageError(f"Nonportable dependency filename: {name}: {relative}")
            if target_root == site_packages:
                source = source_root / Path(relative)
            no_link(source)
            if relative.suffix.lower() == ".pth":
                # A .pth may run arbitrary Python and attach another Python
                # environment. This collector cannot certify such relocation.
                lines = source.read_text(encoding="utf-8-sig").splitlines()
                if any(line.strip() and not line.lstrip().startswith("#") for line in lines):
                    raise RuntimePackageError(f"Dependency requires an executable/path .pth file: {name}: {relative}")
            copy_file(source, target_root / Path(relative), copied, output)
    return imports


VERIFY_SCRIPT = r'''
import importlib, importlib.metadata as metadata, json, pathlib, sys
root = pathlib.Path(sys.executable).resolve().parent
assert pathlib.Path(sys.prefix).resolve() == root, 'Python prefix escaped the packaged runtime'
assert sys.flags.isolated and not __import__('site').ENABLE_USER_SITE, 'Python isolation is disabled'
assert sys.dont_write_bytecode, 'Owned Python workers must not write bytecode'
for entry in sys.path:
    path = pathlib.Path(entry).resolve()
    assert path == root or root in path.parents, 'External Python search path: ' + str(path)
expected = json.loads(sys.argv[1])
for name, version in expected['distributions'].items():
    assert metadata.version(name) == version, 'Incorrect copied dependency: ' + name
for name in expected['imports']:
    module = importlib.import_module(name)
    location = getattr(module, '__file__', None)
    if location:
        path = pathlib.Path(location).resolve()
        assert root in path.parents, 'Dependency loaded outside package: ' + name
print(json.dumps({'pythonVersion': __import__('platform').python_version(), 'imports': expected['imports']}))
'''


def isolated_environment(output: Path) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith(("PYTHON", "VIRTUAL_ENV", "CONDA"))}
    environment.pop("PLANHUB_PYTHON_APP_ROOT", None)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    # Do not allow PATH to supply the build Python DLLs or dependency binaries.
    environment["PATH"] = str(output) + os.pathsep + str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32")
    return environment


def runtime_inventory(output: Path) -> dict[str, str]:
    result = {}
    for file in output.rglob("*"):
        if file.is_file():
            with file.open("rb") as stream:
                result[file.relative_to(output).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    return result


def verify_runtime(output: Path, distributions, imports: set[str]) -> None:
    expected = {"distributions": {name: distribution.version for name, distribution in distributions.items()}, "imports": sorted(imports | STDLIB_PROBE)}
    environment = isolated_environment(output)
    before = runtime_inventory(output)
    with tempfile.TemporaryDirectory(prefix="planhub-runtime-probe-") as directory:
        result = subprocess.run(
            [str(output / "python.exe"), "-I", "-c", VERIFY_SCRIPT, json.dumps(expected)],
            cwd=directory, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
        )
    if result.returncode != 0:
        raise RuntimePackageError("Copied Python/dependencies failed the isolated relocation check:\n" + result.stderr[-8000:])
    after = runtime_inventory(output)
    if before != after:
        raise RuntimePackageError("Python dependency imports changed the runtime files")


def verify_app_bootstrap(output: Path) -> None:
    environment = isolated_environment(output)
    before = runtime_inventory(output)
    with tempfile.TemporaryDirectory(prefix="planhub-runtime-worker-probe-") as directory:
        application = Path(directory)
        (application / "local_probe.py").write_text("VALUE = 42\n", encoding="utf-8")
        (application / "nested").mkdir()
        (application / "nested" / "local_probe.py").write_text("VALUE = 84\n", encoding="utf-8")
        (application / "nested" / "worker.py").write_text(
            "import pathlib, sys, local_probe\n"
            "assert sys.dont_write_bytecode and local_probe.VALUE == 84\n"
            "assert pathlib.Path(local_probe.__file__).resolve().parent == pathlib.Path(__file__).resolve().parent\n",
            encoding="utf-8",
        )
        (application / "worker.py").write_text(
            "import pathlib, subprocess, sys, local_probe\n"
            "assert sys.dont_write_bytecode\n"
            "assert local_probe.VALUE == 42\n"
            "assert pathlib.Path(local_probe.__file__).resolve().parent == pathlib.Path(__file__).resolve().parent\n"
            "if len(sys.argv) == 1:\n"
            "    subprocess.run([sys.executable, __file__, 'worker'], check=True)\n",
            encoding="utf-8",
        )
        environment["PLANHUB_PYTHON_APP_ROOT"] = str(application)
        # Also execute a nested original worker through the same sys.executable
        # pattern used by source-owned data generation, with no -B switch.
        worker = application / "worker.py"
        with worker.open("a", encoding="utf-8") as file:
            file.write("    subprocess.run([sys.executable, str(pathlib.Path(__file__).parent / 'nested' / 'worker.py')], check=True)\n")
        for arguments in [[str(worker)], [str(application / "nested" / "worker.py")], ["-c", "import local_probe, sqlite3, ssl; assert local_probe.VALUE == 42"]]:
            result = subprocess.run([str(output / "python.exe"), *arguments], cwd=directory, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            if result.returncode != 0:
                raise RuntimePackageError("Copied Python cannot run release-local imports or original child workers:\n" + result.stderr[-4000:])
        if any(application.rglob("*.pyc")):
            raise RuntimePackageError("Owned Python workers wrote bytecode into the application directory")
    after = runtime_inventory(output)
    if before != after:
        raise RuntimePackageError("Owned Python workers changed the runtime files")


def package_runtime(output: Path, requirements: list[Path]) -> dict:
    if sys.platform != "win32" or platform.python_implementation() != "CPython" or platform.machine().upper() not in {"AMD64", "X86_64"} or sys.maxsize <= 2**32:
        raise RuntimePackageError("Build the portable runtime with Windows x64 CPython")
    if sys.version_info < (3, 11) or sysconfig.get_config_var("Py_GIL_DISABLED") or hasattr(sys, "gettotalrefcount"):
        raise RuntimePackageError("Use standard Windows x64 CPython 3.11+ (not a debug/free-threaded build)")
    output = output.absolute()
    no_link(output)
    if output.exists():
        raise RuntimePackageError("Runtime destination exists; choose a new directory")
    distributions = resolve_distributions(requirements_from_files(requirements))
    base = Path(sys.base_prefix).absolute()
    # Never write into a Python installation, its parent, or its descendants.
    for installation in {base, Path(sys.prefix).absolute()}:
        if output == installation or output in installation.parents or installation in output.parents:
            raise RuntimePackageError("Runtime destination must be outside the build Python installation")
    output.mkdir(parents=True)
    copied = {}
    copy_base(base, output, copied)
    imports = copy_distributions(distributions, output, copied)
    pth_name = f"python{sys.version_info.major}{sys.version_info.minor}._pth"
    (output / pth_name).write_text(f".\npython{sys.version_info.major}{sys.version_info.minor}.zip\nDLLs\nLib/site-packages\nimport site\n", encoding="utf-8")
    verify_runtime(output, distributions, imports)
    verify_app_bootstrap(output)
    summary = {
        "schemaVersion": 1,
        "platform": "win32-x64",
        "implementation": "CPython",
        "pythonVersion": platform.python_version(),
        "executable": "python.exe",
        "distributions": {name: distribution.version for name, distribution in sorted(distributions.items())},
        "verifiedImports": sorted(imports),
        "verifiedStdlib": sorted(STDLIB_PROBE),
        "applicationRootEnvironment": "PLANHUB_PYTHON_APP_ROOT",
    }
    (output / "runtime.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--requirements", action="append", default=[], type=Path)
    arguments = parser.parse_args()
    try:
        summary = package_runtime(arguments.output, arguments.requirements)
        print(json.dumps({"platform": summary["platform"], "pythonVersion": summary["pythonVersion"], "distributionCount": len(summary["distributions"]), "verified": True}))
        return 0
    except (RuntimePackageError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
