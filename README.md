# luna-chat

`luna-chat` は、身内向け Discord サーバーで会話に自然参加する Bot です。  
Discord の投稿を受け取り、Codex CLI app-server を介して AI 推論を行い、必要に応じて返信やリアクションを行います。

## 必要環境

- Node.js
- pnpm
- `codex` コマンドが実行できること
- Discord Bot トークン

## セットアップ

1. 依存関係をインストール

```bash
pnpm install
```

2. 環境変数を設定 例

```bash
DISCORD_BOT_TOKEN=your_bot_token
ALLOWED_CHANNEL_IDS=123456789012345678,234567890123456789
# 任意 未指定時は ~/.luna
LUNA_HOME=~/.luna
```

`LUNA_HOME` は起動時に自動作成され、`$LUNA_HOME/workspace` / `$LUNA_HOME/codex` / `$LUNA_HOME/logs` も自動で準備されます。

3. Codex の設定・認証を準備

このプロジェクトで起動する Codex は `CODEX_HOME=$LUNA_HOME/codex` を使います。  
そのため、設定ファイルや認証情報の参照先はデフォルトの `~/.codex` とは異なります。

認証は次のどちらかで準備してください。

- `~/.codex/auth.json` を `~/.luna/codex/auth.json` へコピーする
- `LUNA_HOME` を変更している場合は `$LUNA_HOME/codex/auth.json` へコピーする
- 次のコマンドで `CODEX_HOME` を指定してログインする

```bash
CODEX_HOME=~/.luna/codex codex login
```

## 実行方法

開発実行 ウォッチ

```bash
pnpm run dev
```

本番想定実行

```bash
pnpm run build
pnpm run start
```

起動後のアプリケーションログは標準出力に加えて `$LUNA_HOME/logs` にも JSONL で出力されます。  
ファイル名は起動時刻ベースの `YYYYMMDD-HHmmss-SSS.log` です。

## 開発で使うコマンド

- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run lint:fix`
- `pnpm run format:check`
- `pnpm run format`
- `pnpm run test`
