# STATUS.md

## 1. 最終更新

- 2026-02-26
- 更新者: AI

## 2. 現在の真実（Project Truth）

- 返信判定は `ALLOWED_CHANNEL_IDS` + 非DM + 非スレッドのみで行う。
- メンション有無は `mentionedBot` として保持するが、返信優先制御には使っていない。
- Bot投稿は無視し、許可チャンネル投稿を AI へ渡す。
- AI 入力には現在メッセージに加えて、同一チャンネルの直近 10 件履歴を初期投入する。
- 追加履歴は MCP tool `read_message_history` で取得できる（1〜100件、未指定30件）。
- 添付ファイルはワークスペースへ保存し、本文末尾へ `<attachment:...>` マーカーを追記する。
- 返信・リアクションは MCP tool `send_message` / `add_reaction` を使用する。
- AI 処理中の typing は Bot が直接メンションされた投稿に限り、8 秒間隔で送信する。
- AI 呼び出し失敗時はフォールバック返信せず、ログ記録のみで終了する。
- 設定は `DISCORD_BOT_TOKEN` / `ALLOWED_CHANNEL_IDS` を必須とし、`LUNA_HOME` 未設定時は `~/.luna` を使う。
- 起動時に `LUNA_HOME` / `workspace` / `codex` を自動作成する。
- Codex app-server は `codex app-server --listen stdio://` を使い、JSON-RPC で接続する。
- `thread/start` は `ephemeral=true` / `personality="friendly"` を使用し、Discord MCP URLを `config.mcp_servers.discord.url` へ注入する。
- server-initiated request のうち、approval 系は `decline` 応答、`requestUserInput` は辞退選択肢を返す。
- Discord MCP サーバーは `http://127.0.0.1:<port>/mcp` で起動し、`read_message_history` / `send_message` / `add_reaction` を提供する。
- heartbeat は `cron` で毎時 00 分 / 30 分（`Asia/Tokyo`）に実行し、`waitForCompletion=true` で重複実行を抑止する。
- heartbeat プロンプトは以下の固定文を使用する。  
  `HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。
- プロンプトは `instructions` / `developerRolePrompt` / `userRolePrompt` に分割し、`instructions` にはワークスペースの `LUNA.md` / `SOUL.md` を連結する。
- 自己改善ドキュメントの自動更新フローは未実装。
- GitHub Actions `docker-publish` で `main` push時に `linux/amd64,linux/arm64` のマルチプラットフォームDockerイメージを `ghcr.io/${owner}/${repo}` へpushする（タグ: `latest` と `github.sha`）。

## 3. 確定済み方針

1. 人格名は「ルナ」。
2. 対象チャンネル限定で動作する。
3. 会話ログ本文は永続保存しない。
4. 初期文脈は直近 10 件、追加文脈は tool use で取得する。
5. heartbeat を定期実行する。
6. 本体コードと `$LUNA_HOME/workspace` を分離する。
7. `STATUS.md` は作業ごとに AI が更新する。

## 4. 直近タスク

1. 実運用トークンで接続・返信フローを継続観測する。
2. `read_message_history` 多用時の遅延傾向をログから確認する。
3. 返信頻度の運用チューニング方針を整理する。

## 5. ブロッカー

- なし。

## 6. リスクメモ

1. 履歴取得回数が増えると遅延が伸びる可能性がある。
2. ログ非永続のため、長期記憶はワークスペース文書運用に依存する。
3. ワークスペース文書の品質が返信品質に直結する。

## 7. 再開時コンテキスト

再開時は以下の順で確認する。

1. `SPEC.md`
2. `PLAN.md`
3. `ARCHITECTURE.md`
4. `RUNBOOK.md`
5. 本ファイル `STATUS.md`

## 8. 実行メモ

- 正規実行環境はローカル常駐。
- VPS / コンテナは将来オプション。
- トークンなど秘密情報は常にマスクする。
- テストランナーは `vitest` を使用する。
