# Repository Guidelines

Codex CLI app-serverとDiscord.jsを使ったDiscord Chat Botを作成します。

## ドキュメント導線

- `docs/SPEC.md`: 要件定義（ルナ人格、メンション必須返信、通常投稿はAI判断、履歴はDiscordから都度取得、自己改善はドキュメント限定）
- `docs/PLAN.md`: マイルストーン、リスクレジスタ、DoD
- `docs/ARCHITECTURE.md`: モジュール構成、データモデル、主要シーケンス、設定項目
- `docs/RUNBOOK.md`: 常時遵守ルール、実行手順、失敗時対応、変更管理
- `docs/STATUS.md`: 現在の真実、確定方針、直近タスク、再開コンテキスト

## 開発スクリプト

- `pnpm run start`: ビルドされたスクリプトを実行する。
- `pnpm run build`: ビルドを実行する。
- `pnpm run dev`: 開発サーバーを実行する(ソースコード更新時に自動で再起動される)。
- `pnpm run typecheck`: TypeScript型チェックを実行する。
- `pnpm run lint`: lintを実行する。
- `pnpm run lint:fix`: lintの自動修正を実行する。
- `pnpm run format`: フォーマットを実行する。
- `pnpm run format:check`: フォーマット差分の有無のみを検査する。

ソースコードを更新した場合、型チェック、lint、フォーマットを実行し、問題がないことを確認してからコミットしてください。

## コミット

履歴は Conventional Commits 形式に従うこと。

- 形式: `<type>: <summary>`
- 3行目以降には具体的な変更内容を記載すること。
- 1コミット1目的を徹底すること。
- 適切な粒度でコミットを行うこと。

## テスト

- t-wadaの推奨する進め方に従うこと。

## 設計

- クリーンアーキテクチャ、SOLID原則に従うこと。
- DDDの原則に従うこと。
- ただしプロジェクトの規模に合わせ、最適な規模の設計を選択すること。
