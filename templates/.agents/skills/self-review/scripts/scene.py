#!/usr/bin/env python3
"""runs.py の ref から、luna-chat replay に渡す場面ファイルを作る。

使い方: python3 scene.py <ref>[=メモ] ... > scenes.json
指定した run の入力をそのまま使う。2つ目以降の run では、それまでの人の発言とルナの投稿を
history 入力（Discordの履歴と同じ形）にまとめて先頭に置き、会話の流れを再現する。
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runs import SESSIONS, load_runs  # noqa: E402

POSTING_TOOLS = ("send_message", "reply_message")


def posted_contents(run):
    for message in run["assistant"]:
        for block in message.get("content", []):
            if block.get("type") == "toolCall" and block.get("name") in POSTING_TOOLS:
                yield block.get("arguments", {}).get("content", "")


def find_luna_id():
    """記録の中から、ルナ自身が送った本文と一致する履歴メッセージの投稿者IDを探す。"""
    if os.environ.get("LUNA_DISCORD_ID"):
        return os.environ["LUNA_DISCORD_ID"]
    all_runs = [run for path in sorted(SESSIONS.glob("*/*.jsonl")) for run in load_runs(path)[1]]
    posted = {content for run in all_runs for content in posted_contents(run) if content}
    for run in all_runs:
        for item in run["inputs"]:
            if item["kind"] != "history":
                continue
            for event in json.loads(item["text"]):
                message = event.get("data", {}).get("message", {})
                author = message.get("author", {})
                if author.get("kind") == "bot" and message.get("content") in posted:
                    return author["id"]
    sys.exit("ルナのDiscord IDが記録から見つかりません。環境変数 LUNA_DISCORD_ID に指定してください")


def find_session(session_id):
    matches = list(SESSIONS.glob(f"*/{session_id}.jsonl"))
    if not matches:
        sys.exit(f"session not found: {session_id}")
    return matches[0]


def luna_posts_as_events(run, template, luna_id):
    """ルナの投稿を、同じチャンネルのDiscordメッセージとして history に入れる形にする。"""
    events = []
    for content in posted_contents(run):
        event = json.loads(json.dumps(template))
        event["id"] = f"luna-{run['at']}-{len(events)}"
        event["occurredAt"] = run["at"]
        msg = event["data"]["message"]
        msg.update({
            "id": event["id"],
            "timestamp": run["at"],
            "author": {"id": luna_id, "kind": "bot", "username": "ルナ", "displayName": "ルナ"},
            "content": content,
            "attachments": [],
            "replyTo": None,
        })
        events.append(event)
    return events


def build(ref, note, luna_id):
    session_id, index = ref.rsplit(":", 1)
    _, runs = load_runs(find_session(session_id))
    index = int(index)
    target = runs[index]
    history, template = [], None
    for run in runs[:index]:
        for item in run["inputs"]:
            if item["kind"] == "history":
                history.extend(json.loads(item["text"]))
            elif item["kind"] == "discord_message":
                event = json.loads(item["text"])
                template = template or event
                history.append(event)
        if template is not None:
            history.extend(luna_posts_as_events(run, template, luna_id))
    inputs = [item for item in target["inputs"] if item["kind"] != "history" or index == 0]
    if index > 0 and history:
        inputs = [{"kind": "history", "text": json.dumps(history[-30:], ensure_ascii=False)}] + inputs
    scene = {"id": ref, "inputs": inputs}
    if note:
        scene["note"] = note
    return scene


def main():
    luna_id = find_luna_id()
    scenes = []
    for arg in sys.argv[1:]:
        ref, _, note = arg.partition("=")
        scenes.append(build(ref, note, luna_id))
    print(json.dumps(scenes, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
