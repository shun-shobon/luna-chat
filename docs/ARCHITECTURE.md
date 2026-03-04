# ARCHITECTURE.md

## 1. 位置づけ

- 本書は、現在の実装構成（`src/modules/**`）に基づく実装準拠アーキテクチャを定義する。
- 要件の正本は `SPEC.md`、運用方針の正本は `RUNBOOK.md`、進行状況の正本は `STATUS.md` とする。

## 2. 設計原則

- KISS: 小さい責務を明確な境界で分割する。
- YAGNI: 現行要件に不要な機能は導入しない。
- DRY: メッセージ整形・履歴取得・typing制御・tool実行を重複実装しない。
- モジュラモノリス + Ports and Adapters を採用する。
- 会話ログ本文は永続化しない（Discord API から都度取得）。

## 3. システム境界

- 本体コード: `luna-chat` リポジトリ。
- ワークスペース: `$LUNA_HOME/workspace`（`LUNA.md` / `SOUL.md` / `HEARTBEAT.md` / `cron.toml`）。
- 外部依存:
  - Discord API（`discord.js` Client / REST）
  - Codex CLI app-server（`codex app-server --listen stdio://`）

## 4. モジュール構成（実装準拠）

### 4.1 Composition Root

- `src/index.ts`
  - 依存配線（RuntimeConfig / MCP / AI / Heartbeat / Cron Prompt Scheduler / Discord Client）
  - シャットダウン処理（SIGINT/SIGTERM）

### 4.2 Runtime/Shared

- `src/modules/runtime-config/runtime-config.ts`
  - 設定値検証（環境変数: `DISCORD_BOT_TOKEN` / `LUNA_HOME`、設定ファイル: `$LUNA_HOME/config.toml`）
  - `config.toml` の `[discord].allowed_channel_ids`（文字列配列）/ `[discord].allow_dm`（boolean）読み込み（`confbox`）
  - `config.toml` の `[heartbeat].cron_time` / トップレベル `time_zone` 読み込み（`confbox`）
  - `config.toml` 未存在時の自動生成（`allowed_channel_ids = []`, `allow_dm = false`, `heartbeat.cron_time = "0 0,30 * * * *"`）
  - `config.toml` の `[ai]` セクションは読み込まず、Codex 側既定のモデル/推論努力値を使用
  - `LUNA_HOME` / `workspace` / `codex` / `logs` の自動作成・書込可否検証
  - `templates` 配下の通常ファイルを再帰的に `workspace` へ不足分のみ自動コピー（既存は非上書き、空ディレクトリは許容、シンボリックリンクは起動エラー）
- `src/shared/logger.ts`
  - 共通 logger（標準出力 + `$LUNA_HOME/logs/*.log` JSONL 出力）
- `src/shared/discord/message-author-label.ts`
  - 表示名ラベル整形（`<name> (ID: <id>)`）
- `src/shared/discord/runtime-reaction.ts`
  - リアクション正規化（`emoji` / `count` / `selfReacted`）

### 4.3 Conversation

- `src/modules/conversation/adapters/inbound/discord-message-create-handler.ts`
  - `messageCreate` ハンドリング
  - 返信判定（非スレッド・DMは`allow_dm`に従う・Guildは許可チャンネル）
  - `RuntimeMessage` 整形（返信先・添付マーカー・リアクション含む）
  - 初期履歴10件の遅延取得関数を AI へ渡す
- `src/modules/conversation/domain/runtime-message.ts`
  - `RuntimeMessage` / `RuntimeReplyMessage` / `RuntimeReaction` 型

### 4.4 AI

- `src/modules/ai/application/channel-session-coordinator.ts`
  - app-server 共有ランタイム管理（Discord / heartbeat / cron prompt）
  - Discord セッション再利用（通常チャンネル投稿は許可チャンネル全体で 1 thread、DM 投稿は `userId` ごとに thread）
  - セッションキー単位の注入済み履歴スコープ管理（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）
  - Discord セッションの 1 時間アイドル TTL 管理（turn 実行中は完了後クローズ）
  - `turn/steer` 優先、失敗時 `turn/start` フォールバック
  - turn完了時の channel 単位コールバック実行
- `src/modules/ai/application/prompt-composer.ts`
  - `instructions` / `developerRolePrompt` / `userRolePrompt` 生成
  - `LUNA.md` / `SOUL.md` 連結
- `src/modules/ai/application/thread-config-factory.ts`
  - thread config 生成（MCP URL + `projects["<resolved workspace>"].trust_level = "trusted"`）
- `src/modules/ai/adapters/outbound/codex/*`
  - `codex-ai-runtime.ts`: app-server 実行ランタイム
  - `json-rpc-client.ts`: JSON-RPC req/resp・server request 応答（req/resp は双方向で debug ログ出力）
  - `turn-result-collector.ts`: turnイベント集約
  - `stdio-process.ts`: 子プロセス制御
- `src/modules/ai/domain/turn-result.ts`
  - turn 完了時の集約結果型
- `src/modules/ai/ports/inbound/ai-service-port.ts`
  - AI サービス（`generateReply` / `generateHeartbeat`）の入力/契約
- `src/modules/ai/ports/outbound/ai-runtime-port.ts`
  - AI runtime のポート定義

### 4.5 MCP

- `src/modules/mcp/inbound/discord-mcp-http-server.ts`
  - `/mcp` HTTP サーバー起動
  - tool 登録（`read_message_history` / `send_message` / `add_reaction` / `start_typing` / `list_channels` / `get_user_detail`）
  - tool 結果をプレーンテキストで返却
- `src/modules/mcp/application/tools/*`
  - tool 単位のユースケース実装
- `src/modules/mcp/adapters/outbound/discord/*`
  - `discord.js` Client 経由の Discord 呼び出し（履歴取得・送信・リアクション・チャンネル参照・ユーザー参照）
- `src/modules/mcp/ports/outbound/*`
  - MCP application から参照する Discord gateway ポート定義

### 4.6 Typing / Heartbeat / Cron Prompt

- `src/modules/typing/typing-lifecycle-registry.ts`
  - channel/source 単位の typing ループ管理
  - 重複起動防止、停止制御
- `src/modules/heartbeat/heartbeat-runner.ts`
  - cron（`[heartbeat].cron_time`、未設定時は毎時00/30）実行
  - トップレベル `time_zone` 未設定時はシステムタイムゾーンで実行
  - heartbeat 失敗時ログのみで継続
- `src/modules/heartbeat/workspace-cron-config.ts`
  - `workspace/cron.toml` の読み込み・zod検証・cron妥当性検証
  - `oneshot` 実行後のジョブ削除書き戻し
- `src/modules/heartbeat/cron-prompt-scheduler.ts`
  - `workspace/cron.toml` のジョブを cron 実行
  - `waitForCompletion=true` とランタイム状態で重複実行を抑止
  - `chokidar` で変更検知しホットリロード
  - 不正設定時は前回有効スケジュールを維持

### 4.7 Attachments

- `src/modules/attachments/domain/attachment-marker.ts`
  - 本文末尾 `<attachment:...>` マーカー付与
- `src/modules/attachments/ports/discord-attachment-store.ts`
  - 添付保存ポート定義
- `src/modules/attachments/application/append-attachments-to-content.ts`
  - 添付保存 + マーカー追記ユースケース
- `src/modules/attachments/adapters/outbound/workspace-discord-attachment-store.ts`
  - ワークスペース保存実装
- `src/modules/ai/codex-generated/*`
  - app-server 型定義（自動生成）

## 5. データモデル

### RuntimeMessage

- `id: string`
- `channelId: string`
- `authorId: string`
- `authorName: string`
- `authorIsBot: boolean`
- `content: string`
- `mentionedBot: boolean`
- `createdAt: string`
- `reactions?: RuntimeReaction[]`（存在時のみ）
- `replyTo?: RuntimeReplyMessage`

### RuntimeReplyMessage

- `id: string`
- `authorId: string`
- `authorName: string`
- `authorIsBot: boolean`
- `content: string`
- `createdAt: string`
- `reactions?: RuntimeReaction[]`（存在時のみ）

### RuntimeReaction

- `emoji: string`
- `count: number`
- `selfReacted?: true`（Bot自身のみ）

## 6. 主要シーケンス

### 6.1 通常受信

1. Discord `messageCreate` を受信する。
2. 自分自身の投稿を除外する。
3. 返信判定（スレッド除外、DMは`allow_dm`で判定、Guildは許可外チャンネルを除外）を行う。
4. 現在メッセージを `RuntimeMessage` に変換する（添付・返信先・リアクション含む）。
5. `mentionedBot=true` の場合のみ typing を開始する（source=`message:<id>`）。
6. セッションキー内で未注入の履歴スコープの場合のみ直近履歴10件を遅延取得し、昇順整形して AI へ渡す（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）。
7. AI は必要に応じて MCP tools を実行する。
8. ハンドラ `finally` でメンション起点 typing を停止する。
9. `send_message` 成功時と turn 完了時コールバックで channel 単位の typing を停止する。Discord セッションは継続し、1時間アイドル時に破棄する（turn 実行中は完了後にクローズ）。

### 6.2 連投時のセッション制御

1. 通常チャンネル投稿は許可チャンネル全体で 1 つの active session を共有し、DM 投稿は `userId` ごとに active session を保持する。
2. 進行中 turn があれば `turn/steer` を試行する。
3. `turn/steer` が失敗した場合は `turn/interrupt` 後に同一セッションキーの thread で `turn/start` を再実行する。

### 6.3 履歴追加取得（tool use）

1. AI が `read_message_history` を呼ぶ。
2. `beforeMessageId` / `afterMessageId` / `aroundMessageId` のいずれか1つを任意指定できる（同時指定不可）。
3. `limit` は 1〜100（既定30）に制限する。
4. Discord API レスポンスを zod で検証し、不正要素はスキップする。
5. 添付を保存して `<attachment:...>` を追記し、昇順で返す。
6. MCP tool の返却は構造化JSONではなくプレーンテキストを返す。

### 6.4 heartbeat 実行

1. cron（`[heartbeat].cron_time`, `waitForCompletion=true`）で起動する（未設定時 `0 0,30 * * * *`）。
   - `time_zone` 未設定時はシステムタイムゾーンを使用する。
2. 固定 heartbeat プロンプトを AI に渡す。
3. 失敗時はログのみ記録して次周期へ継続する。

### 6.5 cron prompt 実行

1. `workspace/cron.toml` の `[jobs.<id>]` から `cron` / `prompt` / `oneshot` を読み込む。
2. 各ジョブを cron（`waitForCompletion=true`）で起動する。
3. 同一ジョブが実行中の場合は次tickをスキップする。
4. `oneshot=true` のジョブは1回試行後に `cron.toml` から削除する（成功/失敗問わず）。
5. `cron.toml` 変更時は `chokidar` で再読込し、再起動なしで反映する。
6. 再読込に失敗した場合は、直前の有効ジョブ構成を維持する。

## 7. 設定

- `DISCORD_BOT_TOKEN`: 必須
- `LUNA_HOME`: 任意（未設定時 `~/.luna`）
- `$LUNA_HOME/config.toml`: 起動時に自動生成（未存在時）
  - `[discord].allowed_channel_ids`: 文字列配列（例: `["123","456"]`）
  - `[discord].allow_dm`: boolean（`false` ならDM無効、`true` ならDM有効。未指定時 `false`）
  - 空配列でも起動継続（Bot は許可チャンネルなし状態で待機）
  - `[ai]` セクションは読み込まない（存在しても無視する）
  - `[heartbeat].cron_time`: cron 文字列（未指定時 `0 0,30 * * * *`）
  - `time_zone`: IANA タイムゾーン（任意、未指定時はシステムタイムゾーン）
- `$LUNA_HOME/workspace/cron.toml`
  - `[jobs.<id>]`
    - `cron`: cron 文字列（必須）
    - `prompt`: AI へ渡す user prompt（必須）
    - `oneshot`: boolean（任意、既定 `false`）
- 起動時に `$LUNA_HOME/workspace` / `$LUNA_HOME/codex` / `$LUNA_HOME/logs` を自動作成する
- 起動時に `templates` 配下の通常ファイルを再帰的に `$LUNA_HOME/workspace` へ不足分のみコピーする（空ディレクトリは許容、シンボリックリンクは起動エラー）

## 8. エラーハンドリング

- AI 呼び出し失敗: 無返信で終了しログを記録する。
- 履歴取得失敗: 警告ログを記録し空履歴で継続する。
- typing 送信失敗: 警告ログを記録し処理継続する。
- 設定不備: 起動時に fail-fast する。

## 9. テスト配置

- テストは実装モジュール近傍に同居配置する（`*.test.ts`）。
- 主要テスト:
  - `src/modules/ai/application/channel-session-coordinator.test.ts`
  - `src/modules/ai/application/prompt-composer.test.ts`（スナップショット）
  - `src/modules/attachments/index.test.ts`
  - `src/modules/runtime-config/runtime-config.test.ts`
  - `src/modules/heartbeat/heartbeat-runner.test.ts`
  - `src/modules/heartbeat/workspace-cron-config.test.ts`
  - `src/modules/heartbeat/cron-prompt-scheduler.test.ts`
  - `src/modules/conversation/adapters/inbound/discord-message-create-handler.integration.test.ts`
  - `src/modules/mcp/inbound/discord-mcp-http-server.test.ts`

## 10. 設計上の決定

1. 会話ログ本文は永続化しない。
2. 初期文脈は直近10件、追加文脈は `read_message_history` で取得する。
3. メンション有無は入力に含めるが優先制御には使わない。
4. 返信・リアクション・追加履歴取得・AI主導typing・許可チャンネル一覧取得・ユーザー詳細取得は MCP tool 経由で実行する。
5. `send_message` / `add_reaction` / `start_typing` は `channelId` または `userId`（DM）で対象を指定できる。
6. `send_message.replyToMessageId` は任意指定とし、返信投稿を表現する。
7. ワークスペース文書は読み込み対象だが、自動更新フローは未実装。
