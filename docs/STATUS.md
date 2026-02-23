# STATUS.md

## 1. 最終更新

- 2026-02-23
- 更新者: AI

## 2. 現在の真実（Project Truth）

- プロジェクトは MVP 定義を完了した。
- `!ping` 依存を廃止し、チャンネル制限 + メンション必須返信フローへ移行済み。
- 通常投稿は AI が tool use で返信可否を決定し、必要時のみ返信ツールを実行する。
- Discord の履歴は AI 呼び出し時に都度取得する実装へ移行済み。
- 過去履歴取得は MCP tool `fetch_discord_history` を呼び出す方式へ移行済み。
- 返信送信は MCP tool `send_discord_reply` を呼び出す方式へ移行済み。
- 環境変数設定は `DISCORD_BOT_TOKEN` / `ALLOWED_CHANNEL_IDS` のみ使用する構成へ削減済み。
- `codex-workspace` は固定パス（`<project>/codex-workspace`）として扱う。
- 謝罪定型文は固定文言を返す実装へ移行済み（外部ファイル設定なし）。
- 改善提案の自動適用フローは保留中（現状は返信/履歴取得ツールに集中）。
- 受信ハンドラをモジュール化し、Discord API モック + AI モックの結合テストを追加済み。
- Codex app-server は JSON-RPC 手順（`initialize` → `initialized` → `thread/start` → `turn/start`）で接続する実装へ更新済み。
- server-initiated request（approval / requestUserInput）へのクライアント応答を実装済み。
- `codex app-server generate-ts` で公式スキーマを生成し、パラメータ互換性を確認済み。
- app-server 起動コマンドは `codex app-server --listen stdio://` を固定使用し、標準入出力で JSON-RPC を送受信する。
- app-server 実行 CWD は固定で `codex-workspace` を使用する。
- reasoning effort は `index.ts` 側で固定し、`thread/start` の `config.model_reasoning_effort` に反映する。
- `thread/start` は `ephemeral=true` と `personality=\"friendly\"` を固定で指定する。
- MCP サーバー設定は `thread/start` の `config` で都度注入する（`config.toml` に依存しない）。
- プロンプトは `instructions` / `developer role prompt` / `user role prompt` に分割し、`thread/start` の `baseInstructions` / `developerInstructions` と `turn/start` 入力へ振り分ける実装に更新済み。
- `docs/RUNBOOK.md` は AI へのプロンプト入力から除外済み（プロジェクト運用ドキュメントとしてのみ利用）。
- `consola.debug` で message受信・AI turn開始/終了・assistant出力・reply tool call本文を追跡できるようにした。
- ロガーは `src/logger.ts` の共通 `consola` を直接参照する構成に統一した。
- `typecheck` / `lint` / `format:check` / `test` / `build` が通る状態を確認済み。
- 今後の正しい方向は「雑談参加 Bot」への移行。
- 本体コードと Codex ワークスペース（自己改善対象）を分離する方針が確定した。

## 3. 確定済み方針

1. 人格名は「ルナ」。
2. 口調は敬語とため口を混在し、優しい少女トーンを維持する。
3. 対象チャンネル限定で動作する。
4. メンション時は必ず返信する。
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
