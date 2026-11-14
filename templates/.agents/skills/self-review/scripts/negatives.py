#!/usr/bin/env python3
"""ワークスペースの指示ファイルにある禁止・否定の言い回しを数える。

使い方: python3 negatives.py
週次の見直しで前回の数と比べ、増えていたら原因のファイルを書き直す材料にする。
"""
import json
import os
import re
import tomllib
from pathlib import Path

WORKSPACE = Path(os.environ.get("LUNA_HOME", Path.home() / ".luna")) / "workspace"
PATTERN = re.compile(r"禁止|しないで|しない|避け|やめ|てはいけ|ないこと|ダメ|NG")


def targets():
    for name in ("LUNA.md", "MEMORY.md", "HEARTBEAT.md", "AGENDA.md"):
        yield name, (WORKSPACE / name).read_text(encoding="utf-8")
    for pattern in ("users/*.md", "prompts/*.md", ".agents/skills/*/SKILL.md"):
        for path in sorted(WORKSPACE.glob(pattern)):
            yield str(path.relative_to(WORKSPACE)), path.read_text(encoding="utf-8")
    jobs = tomllib.loads((WORKSPACE / "cron.toml").read_text(encoding="utf-8")).get("jobs", [])
    for job in jobs:
        yield f"cron.toml#{job['id']}", job.get("prompt", "")


def main():
    counts = {name: len(PATTERN.findall(text)) for name, text in targets()}
    counts = {name: count for name, count in sorted(counts.items(), key=lambda item: -item[1]) if count}
    print(json.dumps({"total": sum(counts.values()), "files": counts}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
