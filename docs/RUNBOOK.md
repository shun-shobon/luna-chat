# RUNBOOK.md

## 1. 目的

この文書は実行ルールである。  
一度読んだら常に従う。

## 2. 不変ルール

1. 返信対象は `ALLOWED_CHANNEL_IDS` に含まれるチャンネルのみ。
2. Bot へのメンションには必ず返信する。
3. スレッドと DM は現時点で非対応。
4. 会話ログ本文は永続保存しない。
5. 文脈が必要なときは Discord から都度取得する。
6. AI の履歴追加取得（tool use）は無制限で許可する。
7. 自己改善は `$ARTEMIS_HOME/workspace` 配下ドキュメントのみ更新可能。
8. Artemis 本体コードは AI 自己改善で更新しない。
9. 秘密情報をログやドキュメントに平文出力しない。
10. `STATUS.md` は作業ごとに AI が更新する。

## 3. 実行手順

### 3.1 起動前チェック

1. `DISCORD_BOT_TOKEN` が設定されていることを確認する。
2. `ALLOWED_CHANNEL_IDS` が 1 件以上設定されていることを確認する。
3. `ARTEMIS_HOME` 未設定時は `~/.artemis` を使用することを確認する。
4. 起動時に `ARTEMIS_HOME` と `$ARTEMIS_HOME/workspace` が自動作成されることを確認する。
5. Codex 起動時に `CODEX_HOME=$ARTEMIS_HOME/codex` を設定する。

### 3.2 開発時コマンド

1. `pnpm run dev`
2. `pnpm run typecheck`
3. `pnpm run lint`
4. `pnpm run format:check`
5. `pnpm run build`

### 3.3 運用時の基本挙動

1. 受信イベントでチャンネル判定を実施する。
2. 文脈取得は AI が必要時に `read_message_history` を使って行う。
3. AI 結果に従って返信する。
4. AI エラー時は、メンション投稿（forceReply）に限り固定謝罪文で返信する。

## 4. プロンプト運用

AI には最低限以下を渡す。

1. ルナの人格定義
2. メンション必須返信ルール
3. 現在メッセージ（channelId/messageId/本文）
4. `forceReply` と `contextFetchLimit`
5. 返信時は `send_message` を使う制約

## 5. 失敗時対応

1. Discord 投稿失敗:
   - 失敗をログ化し、再送は行わない。
2. AI 呼び出し失敗:
   - メンション投稿時のみ固定謝罪文を返信する。
   - 通常投稿は返信せず終了する。
3. 設定不備:
   - 起動を中断する。

## 6. 変更管理

1. 仕様変更は `SPEC.md` に反映する。
2. 実装方針変更は `PLAN.md` と `ARCHITECTURE.md` に反映する。
3. 運用ルール変更は `RUNBOOK.md` に反映する。
4. 進捗・現況は `STATUS.md` に反映する。

## 7. セキュリティ運用

1. トークン値はマスクする。
2. 会話内容を外部へ二次利用しない。
3. 不要なログを残さない。
