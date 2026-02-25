# ARCHITECTURE.md

## 1. 設計原則

- KISS: 最小の部品で目的を達成する。
- YAGNI: 使うまで作らない。
- DRY: 返信判定・文脈構築・プロンプト生成を重複させない。
- 本体コードとワークスペース運用ドキュメントを物理的に分離する。

## 2. システム境界

- `luna-chat` ディレクトリ: Discord Bot 本体コード
- `workspace` ディレクトリ（`$LUNA_HOME/workspace`）: 人格設定、運用ドキュメント、定型文

## 3. モジュール構成（実装準拠）

- `src/config`
  - 環境変数読み込み
  - `ALLOWED_CHANNEL_IDS` 解析
  - `LUNA_HOME`（default: `~/.luna`）を解決し、`LUNA_HOME` / `workspace` / `codex` の自動作成・検証
- `src/discord`
  - Discord.js の受信イベント処理
  - 返信対象判定の適用
  - 現在メッセージ整形・直近履歴 10 件取得・typing 表示
- `src/policy`
  - 返信可否判定（DM・スレッド・許可外チャンネルを除外）
- `src/attachments`
  - 添付ファイルの保存
  - 本文末尾への `<attachment:...>` マーカー付与
- `src/context`
  - Runtime 型定義
  - 日時整形
- `src/ai`
  - Codex CLI app-server 呼び出し
  - thread / turn のセッション制御
  - プロンプト組み立て（`instructions` / `developerRolePrompt` / `userRolePrompt`）
- `src/mcp`
  - Discord MCP サーバー（`/mcp`）
  - `read_message_history` / `send_message` / `add_reaction`
- `src/heartbeat`
  - cron 起点の定期 AI 実行

## 4. データモデル（実装向け）

### RuntimeMessage

- `id: string`
- `channelId: string`
- `authorId: string`
- `authorName: string`
- `authorIsBot: boolean`
- `content: string`
- `mentionedBot: boolean`
- `createdAt: string`

### ConversationContext

- `channelId: string`
- `recentMessages: RuntimeMessage[]`
- `requestedByToolUse: boolean`

### AiInput

- `channelName: string`
- `currentMessage: RuntimeMessage`
- `recentMessages: RuntimeMessage[]`

### HeartbeatInput

- `prompt: string`

## 5. 主要シーケンス

### 5.1 通常受信

1. Discord でメッセージ受信
2. 返信判定（DM・スレッド・許可外チャンネルは終了）
3. 現在メッセージを RuntimeMessage に変換（添付マーカー含む）
4. typing 表示ループを開始
5. 直近履歴 10 件を取得し、時系列昇順で整形
6. AI へ入力（チャンネル名 + 現在メッセージ + 直近履歴）
7. AI が必要時に `read_message_history` / `send_message` / `add_reaction` を tool call
8. typing 表示ループを停止

### 5.2 同一チャンネル連投時

1. チャンネルごとに active session を保持
2. 進行中 turn がある場合は `turn/steer` を試行
3. `turn/steer` が失敗した場合は同一 thread で `turn/start` を再実行
4. turn 完了時に session を破棄

### 5.3 履歴追加取得（tool use）

1. AI が `read_message_history` を呼ぶ
2. Discord API で `beforeMessageId` と `limit`（最大 100）を使って取得
3. 結果を時系列昇順で返す
4. 必要に応じて AI が再度呼び出す

### 5.4 heartbeat 実行

1. cron（毎時 00 分 / 30 分, JST）で heartbeat を起動
2. 固定プロンプトを AI に渡す（`HEARTBEAT.md` の確認、古いタスク推測禁止、該当なしは終了）
3. heartbeat 失敗時はログのみ記録して次周期へ継続

### 5.5 ワークスペースドキュメント運用

1. `buildInstructions` でワークスペースの `LUNA.md` / `SOUL.md` を読み込む
2. 読み込み内容を `instructions` 末尾へ連結する
3. 自動更新フロー（ドキュメント書き換え）は現状未実装

## 6. 設定

- `DISCORD_BOT_TOKEN`: Bot トークン
- `ALLOWED_CHANNEL_IDS`: 返信対象チャンネル ID（カンマ区切り）
- `LUNA_HOME`: luna-chat 作業ルート（未設定時は `~/.luna`）
- `workspace`: 起動時に `$LUNA_HOME/workspace` を自動作成して利用する
- `codex`: 起動時に `$LUNA_HOME/codex` を自動作成し、Codex 実行時の `CODEX_HOME` として使う

## 7. エラーハンドリング

- AI 呼び出し失敗: 無返信で終了し、ログを記録する
- 直近履歴取得失敗: 警告ログを出し、空履歴で継続する
- typing 送信失敗: 警告ログを出し、AI 呼び出しは継続する
- 設定不備: 起動時 fail-fast

## 8. テスト戦略

- ユニット:
  - 返信判定
  - 設定パーサ
  - heartbeat scheduler
  - prompt 生成
- 結合:
  - Discord message handler（Discord API モック + AI モック）
  - MCP server の起動・URL

## 9. 設計上の決定

1. 会話ログは永続化しない。
2. 初期文脈として直近 10 件を付与し、追加は tool use で取得する。
3. メンション有無は入力に含めるが、ハンドラの優先制御には使わない。
4. 返信送信・リアクション付与・追加履歴取得は MCP tool 経由で実施する。
5. ワークスペースドキュメントは読み込み対象だが、自動更新フローは未実装。
