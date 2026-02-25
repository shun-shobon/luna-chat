# STATUS.md

## 1. 最終更新

- 2026-02-25
- 更新者: AI

## 2. 現在の真実（Project Truth）

- プロジェクトは MVP 定義を完了した。
- `!ping` 依存を廃止し、チャンネル制限 + メンション優先返信フローへ移行済み。
- 通常投稿は AI が tool use で返信可否を決定し、必要時のみ返信ツールを実行する。
- Discord の履歴は初期入力に含めず、必要時に MCP tool `read_message_history` で都度取得する実装へ移行済み。
- 過去履歴取得は MCP tool `read_message_history` を呼び出す方式へ移行済み。
- 返信送信は MCP tool `send_message` を呼び出す方式へ移行済み（特定メッセージへの reply ではなくチャンネル送信）。
- `send_message` の入力は `{ channelId, text }` に簡素化済み。
- リアクション付与は MCP tool `add_reaction` を呼び出す方式を追加済み。
- メンション返信の成立条件は従来どおり `send_message` 必須とし、`add_reaction` は補助用途とする。
- Discord MCP の zod スキーマには `describe` で各パラメータ説明を付与済み。
- Discord MCP の tool `description` / zod `describe` は日本語へ統一済み。
- ツール使用方法の説明は MCP メタデータに委譲し、developer role prompt からは削除済み。
- ただし「返信時は必ず `send_message` を使う」指示のみ developer role prompt に残す方針へ更新済み。
- 環境変数設定は `DISCORD_BOT_TOKEN` / `ALLOWED_CHANNEL_IDS` のみ使用する構成へ削減済み。
- `LUNA_HOME` は default `~/.luna` を使用する。
- `workspace` は `$LUNA_HOME/workspace` を使用する。
- 起動時に `LUNA_HOME` と `workspace` を自動作成する。
- フォールバック返信機能（固定謝罪文）を削除済み。
- AI 呼び出し失敗時は、メンション有無に関わらず無返信で終了しログ記録のみ行う。
- Discord 送信失敗時の再送は行わず、ログ記録して処理終了する。
- 改善提案の自動適用フローは保留中（現状は返信/履歴取得ツールに集中）。
- 受信ハンドラをモジュール化し、Discord API モック + AI モックの結合テストを追加済み。
- Codex app-server は JSON-RPC 手順（`initialize` → `initialized` → `thread/start` → `turn/start`）で接続する実装へ更新済み。
- server-initiated request（approval / requestUserInput）へのクライアント応答を実装済み。
- `codex app-server generate-ts` で公式スキーマを生成し、パラメータ互換性を確認済み。
- app-server 起動コマンドは `codex app-server --listen stdio://` を固定使用し、標準入出力で JSON-RPC を送受信する。
- Codex 起動時は `CODEX_HOME=$LUNA_HOME/codex` を設定する。
- app-server 実行 CWD は `$LUNA_HOME/workspace` を使用する。
- reasoning effort は `index.ts` 側で固定し、`thread/start` の `config.model_reasoning_effort` に反映する。
- `thread/start` は `ephemeral=true` と `personality=\"friendly\"` を固定で指定する。
- MCP サーバー設定は `thread/start` の `config` で都度注入する（`config.toml` に依存しない）。
- Discord MCP サーバーは `hono` + `@hono/mcp` の HTTP(Streamable) 実装へ移行済み（`/mcp`）。
- アプリ起動時に Discord MCP サーバーを同時起動し、`thread/start` の `config.mcp_servers.discord.url` に実URLを注入する。
- プロンプトは `instructions` / `developer role prompt` / `user role prompt` に分割し、`thread/start` の `baseInstructions` / `developerInstructions` と `turn/start` 入力へ振り分ける実装に更新済み。
- `docs/RUNBOOK.md` は AI へのプロンプト入力から除外済み（プロジェクト運用ドキュメントとしてのみ利用）。
- `consola.debug` で message受信・AI turn開始/終了・assistant出力・reply tool call本文を追跡できるようにした。
- ロガーは `src/logger.ts` の共通 `consola` を直接参照する構成に統一した。
- `typecheck` / `lint` / `format:check` / `test` / `build` が通る状態を確認済み。
- 2026-02-24 時点で `SPEC` / `ARCHITECTURE` / `RUNBOOK` を現行実装に整合する内容へ更新済み。
- 今後の正しい方向は「雑談参加 Bot」への移行。
- 本体コードと `$LUNA_HOME/workspace`（自己改善対象）を分離する方針が確定した。

## 3. 確定済み方針

1. 人格名は「ルナ」。
2. 口調は敬語とため口を混在し、優しい少女トーンを維持する。
3. 対象チャンネル限定で動作する。
4. メンション投稿は優先的に返信を試みる。
5. 通常投稿への返信は AI 判断とする。
6. 会話ログ本文は永続保存しない。
7. 文脈は Discord から都度取得する。
8. 追加履歴取得（tool use）は無制限。
9. 自己改善はドキュメントのみ更新し、コードは更新しない。
10. `STATUS.md` は作業ごとに AI が更新する。

## 4. 直近タスク

1. 実運用の認証状態で Codex CLI app-server 接続を確認する。
2. tool use の引数スキーマをより厳格にし、誤呼び出し時の回復文言を整備する。
3. 履歴取得遅延の観測ログを運用で確認する。
4. 実環境で返信頻度のチューニングを行う。
5. Bot トークンを設定したローカル常駐運用で実地検証する。
6. prompt 3分割後の返信品質を運用観測で調整する。

## 5. ブロッカー

- なし。

## 6. リスクメモ

1. 履歴追加取得が無制限のため、遅延増加の可能性がある。
2. ログ非永続のため、長期記憶は人格ドキュメント運用に依存する。
3. 自己改善が過剰更新にならないよう、対象ディレクトリ制約が重要。

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
