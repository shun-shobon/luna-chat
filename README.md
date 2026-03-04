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
# 任意 未指定時は ~/.luna
LUNA_HOME=~/.luna
```

`LUNA_HOME` は起動時に自動作成され、`$LUNA_HOME/workspace` / `$LUNA_HOME/codex` / `$LUNA_HOME/logs` も自動で準備されます。  
さらに `$LUNA_HOME/config.toml` が存在しない場合は起動時に自動生成されます。  
許可チャンネルは `config.toml` の `[discord].allowed_channel_ids` で設定します。
DM 応答可否は `[discord].allow_dm` で設定します。
heartbeat 実行タイミングは `[heartbeat].cron_time` で設定します（既定値は毎時 00 / 30 分）。
AI モデルと推論努力値は `config.toml` では設定せず、Codex 側の既定設定を使用します。
`time_zone` は heartbeat と cron prompt の共通タイムゾーンです（未設定時はシステムのタイムゾーンを使用します）。

```toml
time_zone = "Asia/Tokyo"

[discord]
allowed_channel_ids = ["123456789012345678", "234567890123456789"]
allow_dm = false

[heartbeat]
cron_time = "0 0,30 * * * *"
```

`allowed_channel_ids = []`（空配列）でも起動は継続し、その場合 Bot はどのチャンネルにも反応しません。  
`allow_dm = false` では DM に無反応、`allow_dm = true` では DM 投稿も AI 処理対象になります。  
`config.toml` に `[ai]` を書いても読み込まず、Codex 側の既定モデル/既定推論努力値で動作します。  
さらに `templates` 配下の通常ファイルは再帰的に走査され、`$LUNA_HOME/workspace` に同名ファイルが存在しない場合のみ自動でコピーされます（既存ファイルは上書きしません）。シンボリックリンクが含まれる場合は起動エラーになります。  
`$LUNA_HOME/workspace/cron.toml` では任意プロンプトの定期実行を設定できます。`[jobs.<id>]` 形式で `cron` / `prompt` / `oneshot` を指定します。`oneshot = true` のジョブは1回試行後に設定ファイルから自動削除されます。`cron.toml` の変更は `chokidar` で監視され、再起動なしで反映されます。

```toml
[jobs.daily_check]
cron = "0 0 9 * * *"
prompt = "朝のチェックを実行し、必要なら報告してください"
oneshot = false

[jobs.release_once]
cron = "0 30 12 5 3 *"
prompt = "リリース日のチェックを1回だけ実行してください"
oneshot = true
```

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
- `pnpm run knip`
- `pnpm run format:check`
- `pnpm run format`
- `pnpm run test`
