"""Windows end-to-end check against disposable services in a private fixture workspace."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import ProxyHandler, build_opener


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "stop-standalone.ps1"
POWERSHELL = shutil.which("powershell.exe")
NODE = shutil.which("node.exe")
HTTP = build_opener(ProxyHandler({}))
SERVER = '''
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import time

ready, finish = map(Path, sys.argv[1:])
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"app": "fixture", "pid": os.getpid()}).encode())
    def log_message(self, *args):
        pass

with HTTPServer(("127.0.0.1", 0), Handler) as server:
    server.timeout = 0.2
    tmp = ready.with_suffix(".tmp")
    tmp.write_text(str(server.server_port), encoding="ascii")
    tmp.replace(ready)
    deadline = time.monotonic() + 300
    while not finish.exists() and time.monotonic() < deadline:
        server.handle_request()
'''


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


@unittest.skipUnless(os.name == "nt" and POWERSHELL and NODE, "Windows, PowerShell and Node required")
class StopStandaloneTest(unittest.TestCase):
    def start_fixture(self, base, entry, label, manager=None, launcher=None):
        ready, finish = base / f"{label}.port", base / f"{label}.finish"
        args = [sys.executable, "-B", str(entry), str(ready), str(finish)]
        env = os.environ.copy()
        if manager:
            args = [NODE, str(manager), *args]
        elif launcher:
            launcher.write_bytes((
                '@echo off\r\ncd /d "%~dp0"\r\n'
                f'"%FIXTURE_PYTHON%" -B "{entry.name}" "%FIXTURE_READY%" "%FIXTURE_FINISH%"\r\n'
            ).encode("ascii"))
            env.update(FIXTURE_PYTHON=sys.executable, FIXTURE_READY=str(ready), FIXTURE_FINISH=str(finish))
            # Explorer invokes double-clicked batch files with the full quoted launcher path.
            args = f'"{os.environ["ComSpec"]}" /d /s /c ""{launcher}""'
        proc = subprocess.Popen(args, cwd=entry.parent, env=env, creationflags=subprocess.CREATE_NO_WINDOW,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def cleanup():
            finish.touch()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 15
        while not ready.is_file() and time.monotonic() < deadline:
            self.assertIsNone(proc.poll(), f"{label} fixture exited during startup")
            time.sleep(0.05)
        self.assertTrue(ready.is_file(), f"{label} fixture did not start")
        return proc, int(ready.read_text(encoding="ascii"))

    def test_preview_and_stop_only_matching_independent_source(self):
        temp = tempfile.TemporaryDirectory(prefix="planhub-standalone-")
        self.addCleanup(temp.cleanup)
        base = Path(temp.name).resolve()
        root = base / "临时 计划工作台"
        entry = base / "测试 应用" / "standalone_fixture.py"
        foreign = base / "另一份源码" / entry.name
        wrapper = root / "scripts" / "start-background.mjs"
        for script in (entry, foreign):
            script.parent.mkdir(parents=True)
            script.write_text(SERVER, encoding="utf-8")
        wrapper.parent.mkdir(parents=True)
        wrapper.write_text(
            "import {spawn} from 'node:child_process';\n"
            "const [exe, ...args] = process.argv.slice(2);\n"
            "spawn(exe, args, {stdio:'ignore',windowsHide:true}).on('exit', () => {});\n",
            encoding="utf-8",
        )
        target, target_port = self.start_fixture(base, entry, "standalone")
        launcher = entry.parent / "启动 测试.cmd"
        relative, relative_port = self.start_fixture(base, entry, "from-cmd", launcher=launcher)
        other, foreign_port = self.start_fixture(base, foreign, "other-workspace")
        managed, managed_port = self.start_fixture(base, entry, "portal-owned", wrapper)
        write_json(root / "portal/config/apps.json", {
            "platform": {"name": "测试工作台"},
            "groups": [{"id": "fixture-group", "name": "测试", "apps": [{
                "id": "fixture", "enabled": True, "status": "ready", "name": "测试网页", "url": "/fixture/",
            }]}],
        })
        write_json(root / "integration/apps.json", {"applications": {"fixture": {
            "type": "proxy", "target": "http://127.0.0.1:{port}", "stripPrefix": True, "rootRoutes": [],
            "healthPath": "/health", "healthKeys": ["app"], "healthExpected": {"app": "fixture"},
            "standalone": {"launchers": [launcher.name]},
            "start": {"cwd": "../测试 应用", "command": sys.executable, "args": ["-B", entry.name]},
        }}})
        # The registered port is deliberately occupied by the unrelated copy.
        write_json(root / "integration/ports.json", {
            "schemaVersion": 1, "portal": 1, "applications": {"fixture": foreign_port},
        })

        def run_stop(*extra):
            result = subprocess.run(
                [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                 str(SCRIPT), "-Root", str(root), *extra],
                capture_output=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            output = (result.stdout + result.stderr).decode("utf-8", "replace")
            self.assertEqual(result.returncode, 0, output)
            return output

        def health(port):
            with HTTP.open(f"http://127.0.0.1:{port}/health", timeout=3) as response:
                return json.load(response)["pid"]

        ports = [target_port, relative_port, foreign_port, managed_port]
        pids = [health(port) for port in ports]
        preview = run_stop("-ListOnly")
        self.assertEqual([health(port) for port in ports], pids)
        for pid in pids[:2]:
            self.assertRegex(preview, rf"\bPID {pid}\b")
        for pid in pids[2:]:
            self.assertNotRegex(preview, rf"\bPID {pid}\b")
        run_stop()
        target.wait(timeout=10)
        relative.wait(timeout=10)
        run_stop()
        self.assertIsNone(other.poll())
        self.assertIsNone(managed.poll())
        self.assertEqual([health(foreign_port), health(managed_port)], pids[2:])
