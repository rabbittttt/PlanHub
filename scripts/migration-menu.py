"""Interactive launcher for the two existing migration commands."""

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def select(prompt, choices):
    while True:
        # stderr is the log; show the prompt on the console before waiting for input.
        print(prompt, flush=True)
        value = input().strip().upper()
        if value in choices:
            return value
        print("请输入 " + " 或 ".join(choices) + "，然后按回车。")


def preview_plan(arguments):
    phase = "核对迁移计划"
    print(phase, flush=True)
    # The batch launcher redirects stderr to the run log, including errors at startup.
    print(phase, *arguments, file=sys.stderr, flush=True)
    with subprocess.Popen(
        [sys.executable, "-X", "utf8", "-u", "-B", *arguments],
        cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
    ) as process:
        for line in process.stdout:
            print(line, end="", flush=True)
            print(line, end="", file=sys.stderr, flush=True)
        return process.wait()


def main():
    print("1. 迁移旧应用数据库\n2. 迁移旧共享目录")
    option = select("输入 1 或 2，然后按回车：", ("1", "2"))
    arguments = (["scripts/migrate-storage.py", "integration/storage-migration.example.json"]
                 if option == "1" else ["scripts/migrate-shared.py"])
    status = preview_plan(arguments)
    if status:
        return 1
    if select("计划已列出。确认相关服务已停止后，输入 Y 并按回车开始迁移；输入 N 并按回车退出。", ("Y", "N")) == "Y":
        # Exit before the batch starts the stopped-process check.
        return 10 if option == "1" else 11
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
