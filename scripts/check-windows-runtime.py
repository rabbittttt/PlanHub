"""Check installed runtime metadata against new immutable application requirements.

No application imports, pip operations, installs, or network requests are used.
"""
from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
from pathlib import Path
import platform
import re
import sys

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
        raise SystemExit("Selected Python lacks packaging; create a complete delivery with its Windows runtime")


class RuntimeCompatibilityError(Exception):
    pass


def requirements_from_files(files):
    requirements = []
    for file in files:
        continuation = ""
        for line in file.read_text(encoding="utf-8-sig").splitlines():
            text = re.split(r"\s+#", line.strip(), maxsplit=1)[0].strip()
            if not text or text.startswith("#"):
                continue
            if text.endswith("\\"):
                continuation += text[:-1] + " "
                continue
            text, continuation = continuation + text, ""
            try:
                requirement = Requirement(text)
            except Exception as error:
                raise RuntimeCompatibilityError(f"Unsupported requirement in {file.name}: {text}") from error
            if requirement.url:
                raise RuntimeCompatibilityError(f"URL requirements cannot be checked offline: {requirement.name}")
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""}):
                requirements.append(requirement)
        if continuation:
            raise RuntimeCompatibilityError(f"Unfinished requirement line in {file.name}")
    return requirements


def check_distributions(requirements, lookup=metadata.distribution, python_version=None):
    python_version = python_version or platform.python_version()
    selected, extras, processed = {}, {}, {}
    pending = list(requirements)
    while pending:
        requirement = pending.pop()
        name = canonicalize_name(requirement.name)
        if requirement.url:
            raise RuntimeCompatibilityError(f"URL dependency cannot be checked offline: {name}")
        if name not in selected:
            try:
                selected[name] = lookup(name)
            except metadata.PackageNotFoundError as error:
                raise RuntimeCompatibilityError(f"Selected Python is missing dependency: {name}") from error
        distribution = selected[name]
        if not requirement.specifier.contains(distribution.version, prereleases=True):
            raise RuntimeCompatibilityError(f"Selected Python has {name} {distribution.version}; required {requirement.specifier}")
        python_rule = distribution.metadata.get("Requires-Python")
        if python_rule and not SpecifierSet(python_rule).contains(python_version, prereleases=True):
            raise RuntimeCompatibilityError(f"{name} does not support the selected Python version")
        requested = {canonicalize_name(extra) for extra in requirement.extras}
        available = {canonicalize_name(extra) for extra in distribution.metadata.get_all("Provides-Extra", [])}
        if not requested <= available:
            raise RuntimeCompatibilityError(f"Installed {name} does not provide extras: {', '.join(sorted(requested - available))}")
        extras.setdefault(name, set()).update(requested)
        context = frozenset(extras[name])
        if processed.get(name) == context:
            continue
        processed[name] = context
        for declaration in distribution.requires or []:
            try:
                dependency = Requirement(declaration)
            except Exception as error:
                raise RuntimeCompatibilityError(f"Unsupported installed dependency declaration for {name}: {declaration}") from error
            if dependency.marker is None or any(dependency.marker.evaluate({"extra": extra}) for extra in {"", *context}):
                pending.append(dependency)
    return {name: distribution.version for name, distribution in sorted(selected.items())}


def check_runtime(directory):
    summary = json.loads((directory / "runtime.json").read_text(encoding="utf-8-sig"))
    if sys.platform != "win32" or platform.machine().upper() not in {"AMD64", "X86_64"} or sys.maxsize <= 2**32 or platform.python_implementation() != "CPython" or sys.version_info < (3, 11):
        raise RuntimeCompatibilityError("Selected runtime requires Windows x64 CPython 3.11 or newer")
    if summary.get("schemaVersion") != 1 or summary.get("platform") != "win32-x64" or summary.get("implementation") != "CPython" or summary.get("executable") != "python.exe" or summary.get("pythonVersion") != platform.python_version() or summary.get("applicationRootEnvironment") != "PLANHUB_PYTHON_APP_ROOT":
        raise RuntimeCompatibilityError("Selected Python runtime metadata or worker bootstrap is incompatible")
    if Path(sys.executable).resolve() != (directory / "python.exe").resolve():
        raise RuntimeCompatibilityError("The selected bundled Python was not used")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--requirements", action="append", default=[], type=Path)
    arguments = parser.parse_args()
    try:
        check_runtime(arguments.runtime)
        distributions = check_distributions(requirements_from_files(arguments.requirements))
        print(json.dumps({"compatible": True, "pythonVersion": platform.python_version(), "distributions": distributions}))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
