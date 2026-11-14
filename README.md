<p align="center">
  <img src="./.github/assets/banner.jpg" alt="Luna: Discordに暮らす、自律型のパーソナルエージェント" width="100%">
</p>

Lunaは、Discordに常駐して会話し、自分でスケジュールを回して動く個人用のAIエージェントです。ChatGPTのサブスクリプションでモデルを使い、エージェントの実行には [pi](https://github.com/earendil-works/pi) を使います。1つの配置につき、1つのDiscord Bot、1つのワークスペース、1つのChatGPTアカウントを持ちます。

## セキュリティに関する重要事項

Lunaは、Discordの利用者やローカルHTTP APIの呼び出し元をホストの実行権限から隔離しません。Bot宛てのDM、メンション可能なチャンネル、他のBotやWebhook、HTTP APIからの入力により、以下の操作が確認なしに実行される可能性があります。

- 実行ユーザーがアクセス可能なすべてのファイルシステムの読み書き
- 任意のシェルコマンドの実行、ネットワーク通信、パスワードなしsudo
- Botがアクセス可能なすべてのチャンネル・スレッド・DMへの操作
- Home Assistantを接続した場合、そのトークンのユーザーが行えるすべての操作（鍵やアラームを含む）
- ローカルファイルのDiscordへの添付送信
- `@everyone` を含むDiscordの各種メンション通知
- デスクトップを入れた場合、neko のパスワードを知る人による、ログイン済みのChromeを含むデスクトップの操作

**信頼できない第三者が入力できる環境には絶対に配置しないでください。** Dockerコンテナ環境であっても、実行ユーザーにはパスワードなしsudo権限が付与されています。

## できること

- **会話**：常設チャンネル、メンションで始まる一時セッション、DMで会話します。同じ会話の投稿をまとめて受け取り、返信・リアクション・ファイル添付で応えます。
- **ツールの実行**：シェル、ファイル操作、Web検索、画像生成などを、ホスト上で確認なしに実行します。
- **記憶**：会話が途切れると内容を要約して日次記憶に残し、毎日決まった時刻に長期記憶（`MEMORY.md`）とワークスペースを整理します。
- **ハートビート**：ランダムな間隔で起き、チェックリストと「続けたいこと」の一覧（`AGENDA.md`）から一つ進めます。
- **スケジュール実行**：`cron.toml` のジョブを指定時刻に実行します。事前のシェルコマンドで変化があった時だけ起動することもできます。
- **話題をきっかけにする予定**：「旅行の話が出たら感想を聞く」のように、キーワードが会話に出た時に動く予定を、Luna自身が `intents.toml` に書いて管理します。
- **バックグラウンドタスク**：長い調査や制作を作業エージェントへ任せ、会話を止めずに進捗と結果を受け取ります。
- **HTTP API**：ローカルのHTTPでイベントを受け、単発の実行や会話として処理します。
- **Home Assistant**：家の機器の状態を読み、操作します。見ておきたい機器の変化（玄関が開いた、洗濯機が終わったなど）をLuna自身が `home-assistant.toml` に書き、変化があると起きて動きます。HAのAssistの会話エージェントとしても選べ、音声で話しかけられます。
- **ダッシュボード**：会話・タスク・発火予定・使用枠などの現在の状態をブラウザで確認できます（閲覧のみ）。
- **デスクトップ**：ルナ専用のデスクトップとChromeを常駐させます。ルナがログインの要るサイトやアプリを画面で操作し、人はその画面をブラウザから見て手伝えます（Linuxのホストのみ）。

## 動作要件

- OS: macOS / Linux（native）、または Docker（linux/amd64, linux/arm64）
- Discord Bot Token（Message Content、Guild/DM Messages、Typing などのIntentが必要）
- ChatGPTのサブスクリプション（ChatGPTのアカウントでログインして使います）
- Docker で動かす場合：Docker Engine と Docker Compose
- native で動かす場合：[mise](https://mise.jdx.dev/)（Node.js と pnpm を導入します）、ripgrep（エージェントが記憶やワークスペースの検索に使います）、Python 3（同梱のskillのスクリプトに使います）
- Git（任意。日次整理のたびにワークスペースのコミットを残します）

Windows、ダッシュボード以外のWeb UI、HTTPヘルスチェックエンドポイントは提供していません。

## はじめかた

### Docker

GHCRに公開しているイメージを使います。`./data` がコンテナのホームディレクトリにマウントされ、データは `./data/.luna` に保存されます。

```sh
git clone https://github.com/shun-shobon/luna-chat.git
cd luna-chat
cp .env.example .env   # DISCORD_BOT_TOKEN を設定する
mkdir -p data          # コンテナ内の実行ユーザーから書き込めるようにしておく
docker compose run --rm luna-chat node dist/index.mjs login
docker compose up -d
```

### Native

```sh
git clone https://github.com/shun-shobon/luna-chat.git
cd luna-chat
mise install
pnpm install --frozen-lockfile
pnpm run build
pnpm exec luna-chat login
DISCORD_BOT_TOKEN=... pnpm start
```

### ChatGPTへのログイン

`login` はデバイスコード方式です。表示されたURLを任意の端末のブラウザで開き、コードを入力すると、資格情報が `LUNA_HOME/auth/credentials.json` に保存されます。資格情報の更新に失敗した場合はダッシュボードに「ChatGPT 再ログインが必要」と表示されるので、同じ手順で再ログインしてください。

## 設定

### 環境変数

| 変数名                 | 必須   | デフォルト値 | 説明                                                                              |
| ---------------------- | ------ | ------------ | --------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`    | はい   | なし         | Discord Botのトークン。シェルやcheckの子プロセスには渡されません。                |
| `LUNA_HOME`            | いいえ | `~/.luna`    | データ保存先の絶対パス。                                                          |
| `LOG_LEVEL`            | いいえ | `info`       | ログレベル（`trace` / `debug` / `info` / `warn` / `error`）。                     |
| `LUNA_HTTP_HOST`       | いいえ | `127.0.0.1`  | HTTP APIの待ち受けアドレス。Docker Composeではコンテナ内で`0.0.0.0`を使用。       |
| `LUNA_HTTP_PORT`       | いいえ | `3000`       | HTTP APIのポート。Docker Composeではホスト側の公開ポートに使用。                  |
| `LUNA_DASHBOARD_HOST`  | いいえ | `127.0.0.1`  | ダッシュボードの待ち受けアドレス。LANへ公開する場合は`0.0.0.0`。                  |
| `LUNA_DASHBOARD_PORT`  | いいえ | `3001`       | ダッシュボードのポート。Docker Composeではホスト側の公開ポートに使用。            |
| `TZ`                   | いいえ | システム依存 | スケジュール等に用いるタイムゾーン。Docker環境のデフォルトはAsia/Tokyo。          |
| `HOME_ASSISTANT_URL`   | いいえ | なし         | Home AssistantのURL（例 `http://homeassistant.local:8123`）。トークンと組で指定。 |
| `HOME_ASSISTANT_TOKEN` | いいえ | なし         | Home Assistantの長期アクセストークン。シェルやcheckの子プロセスにも渡ります。     |

`LOG_LEVEL` を `debug` または `trace` にすると、メッセージ本文やプロンプト、ツール引数などが標準出力に出ます。既知のトークン等はマスクしますが、平文に含まれる機密情報を完全に取り除けるとは限りません。

### `LUNA_HOME` の中身

起動時、足りないディレクトリやファイルを生成します（既存のファイルは上書きしません）。`*` を付けたものは、ワークスペースを新しく作る初回だけ生成します。

```text
~/.luna/
├── config.toml
├── auth/                  # ChatGPTの資格情報（credentials.json）
├── sessions/              # エージェントのセッションの記録（日付ごと）
├── state/                 # 使用枠など、実行中に書き出す状態（usage.json）
└── workspace/
    ├── LUNA.md            # エージェントの人格や会話方針
    ├── MEMORY.md          # 長期記憶
    ├── memory/            # 日次記憶とトピック記憶
    │   └── topics/know-how.md  # * 調べ方・作業のコツ
    ├── users/README.md    # * 利用者ごとのメモの書き方
    ├── HEARTBEAT.md       # ハートビートで確認するチェックリスト
    ├── AGENDA.md          # 続けたいこと・約束・関心の一覧
    ├── .agents/skills/    # エージェントが必要な時に読む手順
    │   ├── cron/          # cron.tomlの編集
    │   ├── heartbeat/     # HEARTBEAT.mdの運用
    │   ├── self-review/   # * 週次の見直し（会話を振り返ってLUNA.md・MEMORY.mdを直す）
    │   └── x-status-fetch/  # * Xの投稿の取得
    ├── cron.toml          # 定期実行タスクの設定（週次の見直しを含む）
    ├── intents.toml       # 話題をきっかけにする予定（任意。初回には生成しない）
    └── home-assistant.toml  # 状態変化で起動するHome Assistantのエンティティ（任意。初回には生成しない）
```

週次の見直しは、毎週日曜15:00に直近7日の会話から人の反応を拾い、`LUNA.md`・`MEMORY.md` の変更案を `luna-chat replay` で現行と比べ、よくなった時だけルナ自身が反映します。変更前のファイルと比較の結果は `workspace/output/self-review/<日付>/` に残ります。止めたい時は `cron.toml` の `self-review-weekly` を `enabled = false` にしてください。

### `config.toml`

`[memory]` セクションは必須です。その他の項目は省略でき、省略した項目にはデフォルト値が入ります。

```toml
[memory]
enabled = true
maintenance_cron = "0 4 * * *"

[discord]
allowed_channel_ids = []
allow_dm = true
```

- `memory.enabled`: アイドル終了時の記憶保存と日次整理をまとめて有効/無効にします。
- `memory.maintenance_cron`: 日次整理を実行するcronスケジュール（ローカルタイムゾーン）。
- 設定の変更は再起動で反映されます（`/luna channel add/remove` による変更を除く）。モデル、ハートビート間隔、タスクの同時実行数などの全項目は [SPEC.md](./docs/SPEC.md#14-設定仕様) を参照してください。

### `cron.toml`

```toml
[[jobs]]
id = "daily-summary"
enabled = true
kind = "recurring"
cron = "0 21 * * *"
prompt = "今日の会話を確認して、必要ならDiscordへ要約を送る"

[[jobs]]
id = "release-watch"
enabled = true
kind = "recurring"
cron = "*/30 * * * *"
check = "./scripts/check-release.sh"
prompt = "data.check_output にある新しいリリースを要約し、Discordへ報告する"
```

定期ジョブの `check` には、発火時にエージェントより先にワークスペースで実行するシェルコマンドを指定できます。終了コード0で標準出力があれば、その内容を `check_output` としてプロンプトとともに渡します。出力が空、または失敗・タイムアウト（120秒）した場合はエージェントを起動しません。詳細は [SPEC.md](./docs/SPEC.md#131-事前判定コマンド-check) を参照してください。

## 使いかた

### Discord

メッセージを受け取る条件は3つです。

- **常設チャンネル**：`allowed_channel_ids` に登録したチャンネルでは、Luna自身の発言を除くすべてのメッセージを受け取ります。
- **一時セッション**：未登録のチャンネルやスレッドでは、Lunaへのメンションで30分間の一時セッションが始まります。セッション中はメンションなしの発言も受け取ります。
- **DM**：デフォルトですべてのユーザーからのDMを受け取ります。

スラッシュコマンドは、メッセージを受け取れるチャンネルやDMで使えます（未登録チャンネルでは一時セッション中のみ）。

- `/luna model [model] [effort]`: 現在のセッションで使うモデルと推論強度（reasoning effort）を変更します。
- `/luna end`: 現在のセッションを終了します。処理中のターンの完了を待って記憶を保存し、セッションを閉じます。
- `/luna channel add` / `/luna channel remove`: 実行したチャンネルを常設チャンネルに追加・削除します。ギルド内であれば誰でも実行でき、設定ファイルにすぐ反映されます。

### HTTP API

`POST http://127.0.0.1:3000/events` にJSONを送ります。認証はありません。Native起動ではループバックでのみ待ち受け、Docker Composeでもホストのループバックにのみポートを公開します。`LUNA_HTTP_PORT` を設定した場合はURLのポートを読み替えてください。

```sh
curl -i http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{"execution":"one_shot","response_mode":"wait","event":{"type":"sensor.changed.v1","data":{"value":24}}}'
```

- `execution` は独立した実行の `one_shot`、または `session_id` が同じ入力で会話を共有する `conversation` を指定します。
- `response_mode` は受付後すぐ `202` と `request_id` を返す `async`、または処理完了まで待つ `wait` を指定します。両方の実行方式で選べます。`async` の結果を後から取得するAPIはありません。
- `event.type` は空でない文字列、`event.data` は任意のJSON値です。LunaがイベントIDと時刻を付け、エージェントには `event.data.payload` として渡します。
- `wait` の場合、エージェントが `http_respond` ツールで `request_id`、HTTPステータス、JSON本文を指定すると、その内容を処理完了後に返します。指定がなければ `204`、処理失敗なら `500` です。

会話を続ける場合は `execution` を `conversation` にし、同じ `session_id` を送ります。会話は通常のアイドル期限後に終了します。

```sh
curl -i http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{"execution":"conversation","response_mode":"async","session_id":"home-automation","event":{"type":"sensor.changed.v1","data":{"value":25}}}'
```

### Home Assistant

`HOME_ASSISTANT_URL` と `HOME_ASSISTANT_TOKEN` を設定すると、LunaがHome Assistantのエンティティを調べて操作できるようになります。トークンはHAのプロフィール画面の「長期アクセストークン」で作ります。呼べるサービスや対象は制限しないので、操作させたくない機器がある場合は、権限を絞ったHAのユーザーでトークンを作ってください。

状態変化で起動する対象は、ワークスペースの `home-assistant.toml` にLuna自身が書きます。手で書いても構いません。

```toml
watch = ["binary_sensor.front_door", "climate.*"]   # * は任意の文字列
ignore = ["sensor.*_battery"]
cooldown_seconds = 30   # 同じエンティティで起動する最短の間隔（省略時30）
```

Assistの会話エージェントとして使うには、HAにカスタム統合 [ha-luna](https://github.com/shun-shobon/ha-luna) を入れ、Luna の HTTP API のURL（例 `http://luna.local:3000`）を設定します。HAが別のホストにある場合は `LUNA_HTTP_HOST=0.0.0.0` が必要です。HTTP APIには認証がないため、そのネットワーク内の全員がLunaを動かせます。HA側の設定方法はha-lunaのREADMEを参照してください。

### ダッシュボード

`http://127.0.0.1:3001/` を開くと、Lunaのいまの状態を確認できます（3秒ごとに自動更新、閲覧のみ）。

- ChatGPTの認証状態と使用枠
- 会話セッションごとのフェーズ（考え中・待機中など）と経過時間、未処理の入力
- 実行中のハートビート・スケジュール・日次整理などのイベント実行
- タスクボード（実行枠、各タスクの指示・報告・追加指示）
- 次のハートビート・日次整理・スケジュールの発火予定
- Home Assistantとの接続状態と、状態変化の監視の設定
- 最近の出来事（受信メッセージやツールの入力・結果を含むログ）

認証はありません。会話本文やタスクの内容が表示されるため、`LUNA_DASHBOARD_HOST=0.0.0.0` でLANへ公開する場合は、そのネットワーク内の全員が閲覧できます。Docker Composeではホストのループバックにのみ公開します。

### デスクトップ

Ubuntu 24.04 のホスト（native、実行ユーザー `luna`、ログインシェルで `pnpm` が使えること）で、root で次を実行します。

```sh
deploy/desktop/install.sh
```

Google Chrome、neko、AT-SPI などを入れ、`luna-desktop.target` を有効にして起動し、ワークスペースに skill `luna-desktop` を置きます。`http://<ホスト>:8080/` を開き、`/etc/luna-desktop/neko.env` のパスワードでログインすると、ルナの画面を見て操作できます。WebRTC に `59000/udp` を使います。ログインが必要なサイトは、この画面から一度ログインしておくとルナが使えます。構成は [SPEC.md](./docs/SPEC.md#23-デスクトップ) を参照してください。

### 指示の比較（再生）

記録した会話の入力を、異なる `LUNA.md`・`MEMORY.md` で再生して振る舞いを比べられます。外へ作用するツールは実行せず、呼び出しを記録します。詳細は [SPEC.md](./docs/SPEC.md#82-再生-luna-chat-replay) を参照してください。

```sh
pnpm exec luna-chat replay --scenes scenes.json --out ./replay-out \
  current=$LUNA_HOME/workspace proposed=./proposed
```

## 運用

ログはすべて標準出力にJSON Lines形式で出ます。ファイルへの保存、ログローテーション、プロセスの常駐監視は、systemdやDockerなど実行環境のプロセス管理に任せてください。

SIGINTまたはSIGTERMを受け取ると、新しいメッセージの受付を止め、処理中の実行をすべて終えてから終了します。

## ドキュメント

- [SPEC.md](./docs/SPEC.md)：機能仕様、設定項目、エラー時の挙動
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md)：内部アーキテクチャ、状態遷移、設計方針
- [AGENTS.md](./AGENTS.md)：開発の手順と規約、リリース手順

## ライセンス

[MIT](./LICENSE)
