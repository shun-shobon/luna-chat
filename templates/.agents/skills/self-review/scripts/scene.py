#!/usr/bin/env python3
"""runs.py の ref から、luna-chat replay に渡す場面ファイルを作る。

使い方: python3 scene.py <ref>[=メモ] ... > scenes.json
指定した run の入力をそのまま使う。2つ目以降の run では、それまでの人の発言と自分の投稿を
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


def history_authors(all_runs):
    for run in all_runs:
        for item in run["inputs"]:
            if item["kind"] != "history":
                continue
            for event in json.loads(item["text"]):
                message = event.get("data", {}).get("message", {})
                yield message.get("author", {}), message.get("content")


def find_self_author():
    """記録の中から、自分が送った本文と一致する履歴メッセージの投稿者を探す。"""
    all_runs = [run for path in sorted(SESSIONS.glob("*/*.jsonl")) for run in load_runs(path)[1]]
    discord_id = os.environ.get("LUNA_DISCORD_ID")
    posted = {content for run in all_runs for content in posted_contents(run) if content}
    for author, content in history_authors(all_runs):
        if discord_id:
            if author.get("id") == discord_id:
                return author
        elif author.get("kind") == "bot" and content in posted:
            return author
    sys.exit("自分のDiscordの投稿者情報が記録から見つかりません。環境変数 LUNA_DISCORD_ID に自分のIDを指定してください")


def find_session(session_id):
    matches = list(SESSIONS.glob(f"*/{session_id}.jsonl"))
    if not matches:
        sys.exit(f"session not found: {session_id}")
    return matches[0]


def own_posts_as_events(run, template, self_author):
    """自分の投稿を、同じチャンネルのDiscordメッセージとして history に入れる形にする。"""
    events = []
    for content in posted_contents(run):
        event = json.loads(json.dumps(template))
        event["id"] = f"luna-{run['at']}-{len(events)}"
        event["occurredAt"] = run["at"]
        msg = event["data"]["message"]
        msg.update({
            "id": event["id"],
            "timestamp": run["at"],
            "author": self_author,
            "content": content,
            "attachments": [],
            "replyTo": None,
        })
        events.append(event)
    return events


def build(ref, note, self_author):
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
            history.extend(own_posts_as_events(run, template, self_author))
    inputs = [item for item in target["inputs"] if item["kind"] != "history" or index == 0]
    if index > 0 and history:
        inputs = [{"kind": "history", "text": json.dumps(history[-30:], ensure_ascii=False)}] + inputs
    scene = {"id": ref, "inputs": inputs}
    if note:
        scene["note"] = note
    return scene


def main():
    self_author = find_self_author()
    scenes = []
    for arg in sys.argv[1:]:
        ref, _, note = arg.partition("=")
        scenes.append(build(ref, note, self_author))
    print(json.dumps(scenes, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
