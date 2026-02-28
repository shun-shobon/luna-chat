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
- ワークスペース: `$LUNA_HOME/workspace`（`LUNA.md` / `SOUL.md` / `HEARTBEAT.md`）。
- 外部依存:
  - Discord API（`discord.js` / REST）
  - Codex CLI app-server（`codex app-server --listen stdio://`）

## 4. モジュール構成（実装準拠）

### 4.1 Composition Root

- `src/index.ts`
  - 依存配線（RuntimeConfig / MCP / AI / Heartbeat / Discord Client）
  - シャットダウン処理（SIGINT/SIGTERM）

### 4.2 Runtime/Shared

- `src/modules/runtime-config/runtime-config.ts`
  - 環境変数検証（`DISCORD_BOT_TOKEN` / `ALLOWED_CHANNEL_IDS` / `LUNA_HOME`）
  - `LUNA_HOME` / `workspace` / `codex` の自動作成・書込可否検証
- `src/shared/logger.ts`
  - 共通 logger
- `src/shared/discord/message-author-label.ts`
  - 表示名ラベル整形（`<name> (ID: <id>)`）
- `src/shared/discord/runtime-reaction.ts`
  - リアクション正規化（`emoji` / `count` / `selfReacted`）

### 4.3 Conversation

- `src/modules/conversation/adapters/inbound/discord-message-create-handler.ts`
  - `messageCreate` ハンドリング
  - 返信判定（非DM・非スレッド・許可チャンネル）
  - `RuntimeMessage` 整形（返信先・添付マーカー・リアクション含む）
  - 初期履歴10件取得と AI 呼び出し
- `src/modules/conversation/domain/runtime-message.ts`
  - `RuntimeMessage` / `RuntimeReplyMessage` / `RuntimeReaction` 型

### 4.4 AI

- `src/modules/ai/application/channel-session-coordinator.ts`
  - チャンネル単位セッション管理
  - `turn/steer` 優先、失敗時 `turn/start` フォールバック
  - turn完了後の session 破棄とコールバック実行
- `src/modules/ai/application/prompt-composer.ts`
  - `instructions` / `developerRolePrompt` / `userRolePrompt` 生成
  - `LUNA.md` / `SOUL.md` 連結
- `src/modules/ai/application/thread-config-factory.ts`
  - thread config 生成（`model_reasoning_effort` + MCP URL）
- `src/modules/ai/adapters/outbound/codex/*`
  - `codex-ai-runtime.ts`: app-server 実行ランタイム
  - `json-rpc-client.ts`: JSON-RPC req/resp・server request 応答
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
- `src/modules/mcp/application/tools/*`
  - tool 単位のユースケース実装
- `src/modules/mcp/adapters/outbound/discord/*`
  - Discord REST 呼び出し（履歴取得・送信・リアクション・チャンネル参照・ユーザー参照）
- `src/modules/mcp/ports/outbound/*`
  - MCP application から参照する Discord gateway ポート定義

### 4.6 Typing / Heartbeat

- `src/modules/typing/typing-lifecycle-registry.ts`
  - channel/source 単位の typing ループ管理
  - 重複起動防止、停止制御
- `src/modules/heartbeat/heartbeat-runner.ts`
  - cron（毎時00/30, JST）実行
  - heartbeat 失敗時ログのみで継続

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
3. 返信判定（DM/スレッド/許可外チャンネルを除外）を行う。
4. 現在メッセージを `RuntimeMessage` に変換する（添付・返信先・リアクション含む）。
5. `mentionedBot=true` の場合のみ typing を開始する（source=`message:<id>`）。
6. 直近履歴10件を取得し、昇順整形して AI へ渡す。
7. AI は必要に応じて MCP tools を実行する。
8. ハンドラ `finally` でメンション起点 typing を停止する。
9. turn 完了時コールバックで channel 単位の typing を停止し、session を破棄する。

### 6.2 同一チャンネル連投

1. チャンネル単位で active session を保持する。
2. 進行中 turn があれば `turn/steer` を試行する。
3. `turn/steer` が失敗した場合は同一threadで `turn/start` を再実行する。

### 6.3 履歴追加取得（tool use）

1. AI が `read_message_history` を呼ぶ。
2. `limit` は 1〜100（既定30）に制限する。
3. Discord API レスポンスを zod で検証し、不正要素はスキップする。
4. 添付を保存して `<attachment:...>` を追記し、昇順で返す。

### 6.4 heartbeat 実行

1. cron（`0 0,30 * * * *`, `Asia/Tokyo`, `waitForCompletion=true`）で起動する。
2. 固定 heartbeat プロンプトを AI に渡す。
3. 失敗時はログのみ記録して次周期へ継続する。

## 7. 設定

- `DISCORD_BOT_TOKEN`: 必須
- `ALLOWED_CHANNEL_IDS`: 必須（カンマ区切り）
- `LUNA_HOME`: 任意（未設定時 `~/.luna`）
- 起動時に `$LUNA_HOME/workspace` / `$LUNA_HOME/codex` を自動作成する

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
  - `src/modules/conversation/adapters/inbound/discord-message-create-handler.integration.test.ts`
  - `src/modules/mcp/inbound/discord-mcp-http-server.test.ts`

## 10. 設計上の決定

1. 会話ログ本文は永続化しない。
2. 初期文脈は直近10件、追加文脈は `read_message_history` で取得する。
3. メンション有無は入力に含めるが優先制御には使わない。
4. 返信・リアクション・追加履歴取得・AI主導typing・許可チャンネル一覧取得・ユーザー詳細取得は MCP tool 経由で実行する。
5. `send_message.replyToMessageId` は任意指定とし、返信投稿を表現する。
6. ワークスペース文書は読み込み対象だが、自動更新フローは未実装。
