# STATUS.md

## 1. 最終更新

- 2026-03-04
- 更新者: AI

## 2. 現在の真実（Project Truth）

- 返信判定は `$LUNA_HOME/config.toml` の `[discord].allow_dm` + `[discord].allowed_channel_ids` + 非スレッドで行う（DMは `allow_dm` が `true` のときのみ処理）。
- メンション有無は `mentionedBot` として保持するが、返信優先制御には使っていない。
- Bot投稿は無視し、Guildでは許可チャンネル投稿、DMでは `allow_dm=true` の投稿を AI へ渡す。
- AI 入力には現在メッセージを渡し、セッションキー内で未注入の履歴スコープの場合のみ直近 10 件履歴を初期投入する（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）。
- AI 入力メッセージには、リアクションが存在する場合のみ絵文字別 `reactions` を含める（`selfReacted` はBot自身が該当絵文字でリアクション済みのときのみ付与）。
- 追加履歴は MCP tool `read_message_history` で取得できる（1〜100件、未指定30件、`beforeMessageId` / `afterMessageId` / `aroundMessageId` は排他指定）。
- `read_message_history` の返却メッセージにも、リアクションがある場合のみ `reactions` を含める。
- Discord MCP の tool レスポンスは `structuredContent` ではなくプレーンテキストを返す。
- 添付ファイルはワークスペースへ保存し、本文末尾へ `<attachment:...>` マーカーを追記する。
- 添付処理は `src/modules/attachments`（domain/ports/application/adapters）へ集約し、`conversation` と `mcp` の重複実装を解消している。
- 返信・リアクションは MCP tool `send_message` / `add_reaction` を使用する。
- `send_message` / `add_reaction` / `start_typing` は `channelId` または `userId`（DM）のどちらか一方で対象を指定できる。
- `send_message` は任意で `replyToMessageId` を指定でき、指定時は返信投稿として送信する。
- `send_message` の返信投稿は `fail_if_not_exists=false` で送信し、返信先が見つからない場合も通常投稿として継続する。
- `send_message` の返信投稿では `allowed_mentions.replied_user=true` として返信先ユーザーへ通知する。
- AI は必要時に MCP tool `start_typing` で入力中表示を開始できる（8 秒間隔）。
- `start_typing` で開始した入力中表示は、`send_message` 成功時または Discord turn 完了時に自動停止する。
- AI は必要時に MCP tool `list_channels` で `[discord].allowed_channel_ids` に含まれるチャンネル一覧を取得できる。
- AI は必要時に MCP tool `get_user_detail` で `userId` と `channelId` から `user`（基本ユーザー情報 + `displayName` / `nickname`）を取得できる。
- AI turn の開始/終了は `info` ログへ出力し、終了時には `thread/tokenUsage/updated` 由来のトークン使用量（`last`/`total` 内訳）を含める。
- MCP tool 呼び出しは開始時/終了時の両タイミングで `info` ログを出力する。
- Codex app-server との JSON-RPC は request/response を双方向で `debug` ログ出力する（`notification` は対象外）。
- アプリケーションログは標準出力に加えて `$LUNA_HOME/logs/YYYYMMDD-HHmmss-SSS.log` へ JSONL でも出力する。
- ログファイル出力の初期化に失敗した場合は起動を中断する（fail-fast）。
- `list_channels` / `get_user_detail` は権限不足・未存在などの失敗対象を黙ってスキップする。
- 既存の Bot 直接メンション時の typing（8 秒間隔）も併用し、無効化していない。
- 実装構成は `src/modules/*` 中心へ移行済みで、`index.ts` は Composition Root としてモジュール配線のみを担当する。
- `mcp` の application 層は adapters 実装へ直接依存せず、`src/modules/mcp/ports/outbound/*` のポートを介して依存している。
- リアクション正規化と著者ラベル整形は `src/shared/discord/*` に集約している。
- `ai` の turn 結果型は `src/modules/ai/domain/turn-result.ts`、サービス契約は `src/modules/ai/ports/inbound/ai-service-port.ts` を正本としている。
- 旧実装（`src/ai` の非生成コード、`src/context/*`、`src/policy/*`）は削除し、生成型は `src/modules/ai/codex-generated/*` へ移設済み。
- typing 管理は `typing-lifecycle-registry` で一元化している。
- メンション起点の typing は message handler の `finally` で停止し、tool 起点の typing は `send_message` 成功時または Discord turn 完了時コールバックで停止する。
- AI 呼び出し失敗時はフォールバック返信せず、ログ記録のみで終了する。
- 設定は `DISCORD_BOT_TOKEN` を必須とし、`LUNA_HOME` 未設定時は `~/.luna` を使う。
- 許可チャンネルは `$LUNA_HOME/config.toml` の `[discord].allowed_channel_ids`（文字列配列）から読み込む。
- DM 応答可否は `$LUNA_HOME/config.toml` の `[discord].allow_dm`（boolean）から読み込む。
- AI モデル/推論努力値は `config.toml` から読み込まず、Codex 側の既定設定を使用する。
- `config.toml` に `[ai]` セクションが存在しても無視して起動継続する。
- heartbeat 実行スケジュールは `$LUNA_HOME/config.toml` の `[heartbeat].cron_time` から読み込む。
- heartbeat と cron prompt のタイムゾーンは `$LUNA_HOME/config.toml` のトップレベル `time_zone` から読み込む（未設定時はシステムタイムゾーン）。
- `config.toml` が存在しない場合は起動時に自動生成し、`allowed_channel_ids = []`, `allow_dm = false`, `heartbeat.cron_time = "0 0,30 * * * *"` で起動継続する。
- 起動時に `LUNA_HOME` / `workspace` / `codex` / `logs` を自動作成する。
- 起動時に `templates` 配下の通常ファイルを再帰的に `workspace` へ不足分のみコピーし、既存ファイルは上書きしない（空ディレクトリは許容）。
- 起動時に `templates` 配下にシンボリックリンクが含まれる場合は失敗する。
- 起動時に `templates/cron.toml` が `workspace/cron.toml` へ不足分のみ補完される（既存は上書きしない）。
- Codex app-server は `codex app-server --listen stdio://` を使い、JSON-RPC で接続する。
- Codex app-server プロセスは起動時に 1 回だけ起動し、Discord / heartbeat / cron prompt で共有する。
- Discord は通常チャンネル投稿では許可チャンネル全体で 1 セッション（thread）を再利用し、DM 投稿では `userId` ごとに別セッション（thread）を再利用する。
- Discord セッションは各セッション単位で最終メッセージから 1 時間新規メッセージがない場合に閉じる（turn 実行中は完了後に閉じる）。
- `thread/start` は `approvalPolicy="never"` / `ephemeral=true` を使用し、Discord MCP URLを `config.mcp_servers.discord.url` へ注入する。加えて `config.projects["<resolved $LUNA_HOME/workspace>"].trust_level = "trusted"` と `config.skills.config = [{ path = "<resolved $LUNA_HOME/codex/skills/.system/skill-creator/SKILL.md>", enabled = false }, { path = "<resolved $LUNA_HOME/codex/skills/.system/skill-installer/SKILL.md>", enabled = false }]` を注入する。
- server-initiated request のうち、approval 系は `decline` 応答、`requestUserInput` は辞退選択肢を返す。
- Discord MCP サーバーは `http://127.0.0.1:<port>/mcp` で起動し、`read_message_history` / `send_message`（`channelId` または `userId` + 任意 `replyToMessageId`） / `add_reaction`（`channelId` または `userId`） / `start_typing`（`channelId` または `userId`） / `list_channels` / `get_user_detail` を提供する。
- MCP の Discord 呼び出しは `discord.js` の `Client` 経由に統一し、command/history gateway で共通利用する。
- heartbeat は `cron` で `[heartbeat].cron_time`（未設定時 `0 0,30 * * * *`）に従って実行し、`waitForCompletion=true` で重複実行を抑止する。
- `time_zone` 未設定時は heartbeat / cron prompt ともにシステムタイムゾーンで実行する。
- heartbeat プロンプトは以下の固定文を使用する。  
  `HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。
- cron prompt は `workspace/cron.toml` の `[jobs.<id>]` から `cron` / `prompt` / `oneshot` を読み込み実行する。
- `cron.toml` は `chokidar` で監視し、変更時に再起動なしで再読込する。
- `cron.toml` の再読込に失敗した場合は直前の有効スケジュールを維持する。
- `oneshot = true` の cron prompt は1回試行後に `cron.toml` から削除する（成功/失敗問わず）。
- プロンプトは `instructions` / `developerRolePrompt` / `userRolePrompt` に分割し、`instructions` にはワークスペースの `LUNA.md` / `SOUL.md` を連結する。
- `oxlint` では `application`/`ports`/`domain` からの不適切な層依存（adapters/application 直接参照など）を `no-restricted-imports` で検出する。
- 自己改善ドキュメントの自動更新フローは未実装。
- GitHub Actions `docker-publish` で `main` push時に `linux/amd64,linux/arm64` のマルチプラットフォームDockerイメージを `ghcr.io/${owner}/${repo}` へpushする（タグ: `latest` と `github.sha`）。

## 3. 確定済み方針

1. 人格名は「ルナ」。
2. 対象チャンネル限定で動作する。
3. 会話ログ本文は永続保存しない。
4. 初期文脈は直近 10 件、追加文脈は tool use で取得する。
5. heartbeat を定期実行する。
6. cron prompt を `workspace/cron.toml` で定期実行する。
7. 本体コードと `$LUNA_HOME/workspace` を分離する。
8. `STATUS.md` は作業ごとに AI が更新する。
9. `templates` 配下の通常ファイルは起動時に再帰的に `workspace` へ不足分のみ補完する（空ディレクトリは許容、シンボリックリンクは不可）。

## 4. 直近タスク

1. 実運用トークンで接続・返信フローを継続観測する。
2. `read_message_history` 多用時の遅延傾向をログから確認する。
3. 返信頻度の運用チューニング方針を整理する。

## 5. ブロッカー

- なし。

## 6. リスクメモ

1. 履歴取得回数が増えると遅延が伸びる可能性がある。
2. 会話ログ本文を永続化しないため、長期記憶はワークスペース文書運用に依存する。
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
- テストは実装モジュール近傍へ配置している（例: `src/modules/runtime-config/runtime-config.test.ts`）。
