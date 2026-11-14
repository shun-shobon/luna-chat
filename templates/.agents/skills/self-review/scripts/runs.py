#!/usr/bin/env python3
"""会話の記録を実行（run）単位に分け、人の発言とルナの投稿を短く並べる。

使い方: python3 runs.py [日数=7] > runs.jsonl
各行は {"ref": "<セッションID>:<run番号>", "label", "at", "inputs": [...], "luna": [...]}。
inputs は人の発言を「名前: 本文」に、luna はルナの投稿・リアクション・タスク作成を短くしたもの。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

LUNA_HOME = Path(os.environ.get("LUNA_HOME", Path.home() / ".luna"))
SESSIONS = LUNA_HOME / "sessions"
POST_TOOLS = {"send_message", "reply_message", "add_reaction", "task_create", "open_conversation"}


def load_runs(path):
    """記録を run ごとの {inputs, assistant} に分ける。入力が続いた後の応答までを1つの run とする。"""
    lines = [json.loads(line) for line in path.open(encoding="utf-8")]
    head = lines[0] if lines and lines[0].get("type") == "session_open" else {}
    runs, current = [], None
    for line in lines:
        if line.get("type") != "message":
            continue
        message = line["message"]
        if message.get("role") == "luna_input":
            if current is None or current["assistant"]:
                current = {"at": line["at"], "inputs": [], "assistant": []}
                runs.append(current)
            current["inputs"].append({"kind": message["kind"], "text": message["text"]})
        elif message.get("role") == "assistant" and current is not None:
            current["assistant"].append(message)
    return head, runs


def describe_input(item):
    if item["kind"] in ("discord_message", "delegated_conversation", "task_report"):
        try:
            event = json.loads(item["text"])
        except json.JSONDecodeError:
            return f"[{item['kind']}]"
        message = event.get("data", {}).get("message")
        if message:
            author = message.get("author", {})
            name = author.get("displayName") or author.get("username")
            return f"{name}({author.get('id')}): {message.get('content', '')}"
        return f"[{item['kind']}] {json.dumps(event.get('data', {}), ensure_ascii=False)[:300]}"
    return f"[{item['kind']}]"


def describe_luna(run):
    out = []
    for message in run["assistant"]:
        for block in message.get("content", []):
            if block.get("type") == "toolCall" and block.get("name") in POST_TOOLS:
                arguments = block.get("arguments", {})
                body = arguments.get("content") or arguments.get("emoji") or arguments.get("title") or arguments.get("brief")
                out.append(f"{block['name']}: {json.dumps(body, ensure_ascii=False)[:500]}")
    return out


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    since = datetime.now(timezone.utc) - timedelta(days=days)
    for path in sorted(SESSIONS.glob("*/*.jsonl")):
        head, runs = load_runs(path)
        if head.get("kind") != "conversation":
            continue
        for index, run in enumerate(runs):
            if datetime.fromisoformat(run["at"].replace("Z", "+00:00")) < since:
                continue
            inputs = [describe_input(item) for item in run["inputs"] if item["kind"] not in ("task_board", "history")]
            print(json.dumps({
                "ref": f"{path.stem}:{index}",
                "label": head.get("label"),
                "at": run["at"],
                "inputs": inputs,
                "luna": describe_luna(run),
            }, ensure_ascii=False))


if __name__ == "__main__":
    main()
