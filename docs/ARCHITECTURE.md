# ARCHITECTURE.md

## 1. 設計原則

- KISS: 最小の部品で目的を達成する。
- YAGNI: 使うまで作らない。
- DRY: 返信判定・文脈構築・プロンプト生成を重複させない。
- 本体コードと自己改善対象ドキュメントを物理的に分離する。

## 2. システム境界

- `artemis` ディレクトリ: Discord Bot 本体コード（AI 自己改変の対象外）
- `workspace` ディレクトリ（`$ARTEMIS_HOME/workspace`）: 人格設定、運用ドキュメント、定型文（AI 自己改善の対象）

## 3. モジュール構成（提案）

- `src/config`
  - 環境変数読み込み
  - `ALLOWED_CHANNEL_IDS` 解析
  - `ARTEMIS_HOME`（default: `~/.artemis`）を解決し、`ARTEMIS_HOME` と `workspace` の自動作成・検証
- `src/discord`
  - Discord.js クライアント初期化
  - 受信イベント処理
  - 返信送信
- `src/policy`
  - 返信可否判定
  - メンション必須返信ルール
- `src/context`
  - Discord からの都度履歴取得
  - AI へ渡す文脈整形
- `src/ai`
  - Codex CLI app-server 呼び出し
  - tool use 実行ループ
  - 謝罪定型文の読み出し
- `src/improvement`
  - ドキュメント更新要求の判定
  - Codex ワークスペースへの更新実行

## 4. データモデル（実装向け）

### RuntimeMessage

- `id: string`
- `channelId: string`
- `authorId: string`
- `authorName: string`
- `content: string`
- `mentionedBot: boolean`
- `createdAt: string`

### ConversationContext

- `channelId: string`
- `recentMessages: RuntimeMessage[]`
- `requestedByToolUse: boolean`

### AiInput

- `forceReply: boolean`
- `currentMessage: RuntimeMessage`
- `contextFetchLimit: number`

### AiOutput

- `didReply: boolean`

## 5. 主要シーケンス

### 5.1 通常受信

1. Discord でメッセージ受信
2. 許可チャンネル判定（許可以外は終了）
3. メンション有無判定
4. AI へ入力（現在メッセージ + `forceReply` + `contextFetchLimit`）
5. AI が必要時に `read_message_history` を tool call
6. AI が返信時に `send_message` を tool call

### 5.2 メンション受信

1. メンション検出
2. `forceReply=true` で AI 呼び出し
3. AI 返信失敗時は謝罪定型文を返す

### 5.3 履歴追加取得（tool use）

1. AI が追加履歴要求
2. Discord API でさらに過去メッセージを取得
3. AI へ再投入
4. AI が終了判断するまで反復（無制限）

### 5.4 自己改善

1. AI が改善提案を生成
2. 対象が `$ARTEMIS_HOME/workspace` 配下ドキュメントか検証
3. 条件を満たす場合のみ更新
4. `STATUS.md` に更新内容を記録

## 6. 設定

- `DISCORD_BOT_TOKEN`: Bot トークン
- `ALLOWED_CHANNEL_IDS`: 返信対象チャンネル ID（カンマ区切り）
- `ARTEMIS_HOME`: Artemis 作業ルート（未設定時は `~/.artemis`）
- `workspace`: 起動時に `$ARTEMIS_HOME/workspace` を自動作成して利用する
- `CODEX_HOME`: Codex 起動時に `$ARTEMIS_HOME/codex` を設定する
- `APOLOGY_TEMPLATE_PATH`: 現時点では未使用（謝罪定型文は固定文言）

## 7. エラーハンドリング

- AI 呼び出し失敗: `forceReply=true` 時のみ謝罪定型文で返信
- Discord 送信失敗: ログ記録して処理終了（再送なし）
- 設定不備: 起動時 fail-fast

## 8. テスト戦略

- ユニット:
  - チャンネル判定
  - メンション必須返信判定
  - 設定パーサ
- 結合:
  - Discord API モック + AI モックで会話フロー
  - tool use での履歴追加ループ
- E2E:
  - 可能範囲で実施（必須ではない）

## 9. 設計上の決定

1. 会話ログは永続化しない。
2. 文脈は必要時に tool use で Discord から取得する。
3. 返信頻度や興味判定は AI 判断に寄せる。
4. 履歴取得と返信送信は tool use 経由で実施する。
5. 自己改善はドキュメント限定で実施する。
