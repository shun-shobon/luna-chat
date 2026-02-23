# Repository Guidelines

Codex CLI app-serverとDiscord.jsを使ったDiscord Chat Botを作成します。

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
