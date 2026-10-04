# Luna

Lunaは、DiscordとローカルHTTP APIをインターフェースとしてCodexを自律稼働させる個人用のワークスペースエージェントです。入力を共通イベントに変換し、会話の管理、ホスト上のファイルシステムやコマンドの実行、記憶の蓄積、ハートビート、スケジュールタスクを単一のワークスペース内で統合処理します。

## セキュリティに関する重要事項

Lunaは、Discordの利用者やローカルHTTP APIの呼び出し元をホストの実行権限から隔離しません。Bot宛てのDM、メンション可能なチャンネル、他のBotやWebhook、HTTP APIからの入力により、以下の操作が確認なしに実行される可能性があります。

- 実行ユーザーがアクセス可能なすべてのファイルシステムの読み書き
- 任意のシェルコマンドの実行、ネットワーク通信、パスワードなしsudo
- Botがアクセス可能なすべてのチャンネル・スレッド・DMへの操作
- ローカルファイルのDiscordへの添付送信
- `@everyone` を含むDiscordの各種メンション通知

**信頼できない第三者が入力できる環境には絶対に配置しないでください。** Dockerコンテナ環境であっても、実行ユーザーにはパスワードなしsudo権限が付与されています。

## 動作要件

- OS: macOS / Linux（native）、または Docker（linux/amd64, linux/arm64）
- Runtime: Node.js `24.21.0`, pnpm `12.7.0`
- その他:
  - Discord Bot Token（Message Content、Guild/DM Messages、Typing 等の各種Intentが必要）
  - PATH上にインストールされた `codex` コマンド（native実行時）
  - Docker Engine および Docker Compose（Docker実行時）
  - Git（日次整理のコミット履歴を残す場合）

※ Windows、Web UI、HTTPヘルスチェックエンドポイント等は提供していません。

## 事前準備（Codexの認証）

初回起動前に、Luna専用のディレクトリでCodexの認証を完了させておく必要があります。

### Native環境の場合

```sh
mkdir -p "$HOME/.luna/codex"
CODEX_HOME="$HOME/.luna/codex" codex login
CODEX_HOME="$HOME/.luna/codex" codex login status
```

### Docker環境の場合

ヘッドレス環境ではデバイス認証を利用できます。事前にホスト側の `./data` がコンテナにマウントされる設定を確認してください。

```sh
docker compose run --rm luna-chat codex login --device-auth
docker compose run --rm luna-chat codex login status
```

## 環境変数

| 変数名              | 必須   | デフォルト値 | 説明                                                                        |
| ------------------- | ------ | ------------ | --------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | はい   | なし         | Discord Botのトークン。Codexの子プロセスには渡されません。                  |
| `LUNA_HOME`         | いいえ | `~/.luna`    | データ保存先の絶対パス。                                                    |
| `LOG_LEVEL`         | いいえ | `info`       | ログレベル（`trace` / `debug` / `info` / `warn` / `error`）。               |
| `LUNA_HTTP_HOST`    | いいえ | `127.0.0.1`  | HTTP APIの待ち受けアドレス。Docker Composeではコンテナ内で`0.0.0.0`を使用。 |
| `LUNA_HTTP_PORT`    | いいえ | `3000`       | HTTP APIのポート。Docker Composeではホスト側の公開ポートに使用。            |
| `TZ`                | いいえ | システム依存 | スケジュール等に用いるタイムゾーン。Docker環境のデフォルトはAsia/Tokyo。    |

※ `LOG_LEVEL` を `debug` または `trace` に設定すると、メッセージ本文やプロンプト、ツール引数などが標準出力に出力されます。既知のトークン等はマスクされますが、平文に含まれる機密情報の完全な除去は保証されません。

## ディレクトリ構成

初回起動時、不足しているディレクトリやファイルが自動生成されます（既存のファイルは上書きされません）。

```text
~/.luna/
├── config.toml
├── codex/                 # 専用CODEX_HOME（認証情報・スレッド保存先）
└── workspace/
    ├── LUNA.md            # エージェントの人格や会話方針
    ├── MEMORY.md          # 長期記憶
    ├── memory/            # 日次会話ログ（初回の記憶保存時に自動生成）
    ├── HEARTBEAT.md       # 定期ハートビート用チェックリスト
    ├── .agents/skills/    # cronやheartbeatの運用手順
    │   ├── cron/SKILL.md
    │   └── heartbeat/SKILL.md
    └── cron.toml          # 定期実行タスクの設定
```

### `config.toml` の基本設定

設定ファイルでは `[memory]` セクションが必須です。その他の項目は省略可能で、デフォルト値が適用されます。

```toml
[memory]
enabled = true
maintenance_cron = "0 4 * * *"

[discord]
allowed_channel_ids = []
allow_dm = true
```

- `memory.enabled`: アイドル終了時の記憶保存および日次整理を一括で有効/無効化します。
- `maintenance_cron`: 日次整理を実行するcronスケジュール（ローカルタイムゾーン）。
- 設定変更の反映には再起動が必要です（`/luna channel add/remove` による変更を除く）。詳細は [SPEC.md](./docs/SPEC.md#14-設定仕様) を参照してください。

### `cron.toml` の設定例

```toml
[[jobs]]
id = "daily-summary"
enabled = true
kind = "recurring"
cron = "0 21 * * *"
prompt = "今日の会話を確認して、必要ならDiscordへ要約を送る"
```

## セットアップと起動

### Native環境

```sh
mise install
pnpm install --frozen-lockfile
pnpm run gen
pnpm run build
DISCORD_BOT_TOKEN=... ./dist/luna-chat
```

開発時は以下を実行します：

```sh
pnpm run dev
```

### Docker環境

```sh
cp .env.example .env
mkdir -p data
# .env に DISCORD_BOT_TOKEN を設定
docker compose up
```

※ `./data` ディレクトリはコンテナ内の実行ユーザーから書き込み可能である必要があります。

## Discordでの利用方法

### メッセージの受付条件

- **常設チャンネル**: `allowed_channel_ids` に登録されたチャンネルでは、Luna自身の発言を除くすべてのメッセージを受信します。
- **一時セッション**: 未登録のチャンネルやスレッドでは、Lunaへのメンションによって30分間の一時セッションが開始されます。セッション継続中はメンションなしの発言も受信します。
- **DM**: デフォルトですべてのユーザーからのDMを受信します。

### スラッシュコマンド

通常のメッセージを受信できるチャンネルやDMで利用可能です（未登録チャンネルでは一時セッション中のみ実行可能）。

- `/luna model [model] [effort]`: 現在のセッションで使用するモデルと推論強度（reasoning effort）を変更します。
- `/luna end`: 現在のセッションを手動で終了します。処理中のターン完了を待って記憶を保存し、セッションを閉じます。
- `/luna channel add` / `/luna channel remove`: 実行したチャンネルを常設チャンネル（`allowed_channel_ids`）に追加または削除します（ギルド内であれば誰でも実行可能で、設定ファイルに即座に反映されます）。

## HTTP APIでの利用方法

`POST http://127.0.0.1:3000/events` にJSONを送ります。認証はありません。Native起動ではループバックにのみ待ち受け、Docker Composeでもホストのループバックにのみポートを公開します。`LUNA_HTTP_PORT` を設定した場合はURLのポートを読み替えてください。

```sh
curl -i http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{"execution":"one_shot","response_mode":"wait","event":{"type":"sensor.changed.v1","data":{"value":24}}}'
```

- `execution` は独立した実行の `one_shot`、または `session_id` が同じ入力で会話を共有する `conversation` を指定します。
- `response_mode` は受付後すぐ `202` と `request_id` を返す `async`、または処理完了まで待つ `wait` を指定します。両方の実行方式で選べます。`async` の結果を後から取得するAPIはありません。
- `event.type` は空でない文字列、`event.data` は任意のJSON値です。LunaがイベントIDと時刻を付け、Codexには `event.data.payload` として渡します。
- `wait` の場合、瑠菜が `http.respond` Effectで `request_id`、HTTPステータス、JSON本文を指定すると、その内容を処理完了後に返します。指定がなければ `204`、処理失敗なら `500` です。

会話を継続する場合は `execution` を `conversation` にし、同じ `session_id` を送ります。会話は通常のアイドル期限後に終了します。

```sh
curl -i http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{"execution":"conversation","response_mode":"async","session_id":"home-automation","event":{"type":"sensor.changed.v1","data":{"value":25}}}'
```

## 記憶と自律運用

- **セッション記憶保存**: 会話が30分間途切れてアイドル状態になると、Codexが会話内容を要約し、`memory/YYYY-MM-DD.md` に追記保存します。
- **日次整理**: 指定したcron時刻（デフォルト午前4時）に専用スレッドが起動し、日次ログや `MEMORY.md`、ワークスペース全体を見直して記憶の統合やファイルの整理を行います。Gitが利用可能な場合は、ローカルにコミットを作成します。
- **ハートビート**: 一定間隔（ランダムなインターバル）ごとに `HEARTBEAT.md` を読み込み、自律的なチェックタスクを実行します。
- **スケジュール実行**: `cron.toml` に定義されたジョブに基づき、指定時刻にプロンプトを実行します。

## ログとプロセス管理

ログはすべて標準出力にJSON Lines形式で出力されます。ファイル保存やログローテーション、プロセスの常駐監視は、実行環境のプロセス管理ツール（systemd、Docker等）に委ねられています。

SIGINTまたはSIGTERMを受信すると、新規メッセージの受付を停止し、処理中のタスクをすべて完了させてから正常に終了します。

## 開発とテスト

```sh
pnpm run gen          # Codex CLIから型を生成
pnpm run format:check # フォーマット確認
pnpm run lint         # 静的解析
pnpm run knip         # 未使用コード検出
pnpm run typecheck    # 型チェック
pnpm run test         # テスト実行
pnpm run build        # バイナリビルド
docker compose build  # Dockerイメージビルド
```

## リリース手順

GitHub Actionsの `release` ワークフローをmainブランチから手動実行し、`patch`、`minor`、`major` を選択します。[easy-release](https://github.com/shun-shobon/easy-release) が最新の安定版Gitタグを基準に次のバージョンを計算し、`package.json` の更新後に `pnpm format` を実行し、整形結果を含むPull Requestを作成します。GitHubの「Settings > Actions > General > Workflow permissions」で「Allow GitHub Actions to create and approve pull requests」を有効にしてください。

準備PRをmainブランチにマージすると、リリースタグとドラフトReleaseを作成し、各OS向けSEAアセットの添付とGHCRへのDockerイメージのプッシュを実行します。すべてのビルドと証明の付与が成功した後、Dockerイメージの `latest` タグを更新してGitHub Releaseを公開します。更新対象は `.github/easy-release.json` で指定します。

## ドキュメント一覧

- [SPEC.md](./docs/SPEC.md): 機能仕様、設定項目、エラー時の挙動などの詳細
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md): 内部アーキテクチャ、状態遷移、設計方針の詳細
