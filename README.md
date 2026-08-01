# Luna

Lunaは、Discordを入口にCodexを動かす個人用workspace agentです。Discordの会話、host上のfilesystemとcommand、記憶保存、heartbeat、時刻指定jobを一つのLuna workspaceへ接続します。

## 最初に読む注意

LunaはDiscord利用者をhost権限から隔離しません。BotへDMできる利用者、設定外channelでLunaをmentionできる利用者、他Bot、Webhookの入力から、次の操作が確認なしに実行され得ます。

- 実行userが読書きできる全filesystem
- command、host network、passwordless sudo
- Botが到達できる全channel、thread、DM
- local fileのDiscord添付
- `@everyone`を含むDiscord標準mention通知

信頼できない利用者やBotが入力できる環境へ配置しないでください。Dockerでもprocess userへpasswordless sudoを与える設計です。

## 対応環境

- native macOS / Linux
- Docker on linux/amd64 / linux/arm64
- Node.js `24.18.1`
- pnpm `11.18.0`

Windows、公開CLI、systemd unit、launchd plist、HTTP health endpointは提供しません。

## 必要なもの

- Discord Bot token
- Discord Gatewayのmessage content、Guild/DM message、typingに必要なintent
- Codex認証を保存できる永続directory
- native実行ではmise（shell activation済み）
- 日次整理をlocal commitへ残す場合はGit
- Docker実行ではDocker EngineとCompose

Codex executableはpnpmで固定した`@openai/codex`だけを使います。hostのPATHにある別versionへfallbackしません。

初回起動前に、Luna専用Codex homeへ認証します。nativeではdependency install後に次を実行し、browser flowを完了してください。

```sh
mkdir -p "$HOME/.luna/codex"
CODEX_HOME="$HOME/.luna/codex" ./node_modules/.bin/codex login
CODEX_HOME="$HOME/.luna/codex" ./node_modules/.bin/codex login status
```

headlessなDocker hostではdevice authを使えます。Composeが`./data`を`/home/node`へmountすることを先に確認してください。

```sh
docker compose run --rm luna-chat codex login --device-auth
docker compose run --rm luna-chat codex login status
```

## Environment

| 変数                | 必須   | 既定値      | 説明                                                                   |
| ------------------- | ------ | ----------- | ---------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | はい   | なし        | Discord Bot token。Codex child processへ渡しません。                   |
| `LUNA_HOME`         | いいえ | `~/.luna`   | 絶対pathだけを指定できます。                                           |
| `LOG_LEVEL`         | いいえ | `info`      | `trace` / `debug` / `info` / `warn` / `error`。                        |
| `TZ`                | いいえ | process依存 | scheduleに使うNode.js local timezone。Dockerは未指定時Asia/Tokyoです。 |

`LOG_LEVEL=debug`または`trace`では、Discord本文、prompt、tool引数、actionがstdoutへ出ます。Bot token等の既知fieldはredactしますが、自由文へ埋め込まれたcredentialや個人情報の除去は保証しません。

## Data layout

初回起動は不足するdirectoryとfileだけを作り、既存fileを上書きしません。

```text
~/.luna/
├── config.toml
├── codex/                 # 専用CODEX_HOME、認証、保存thread
└── workspace/
    ├── LUNA.md            # 人格と会話方針
    ├── MEMORY.md          # 長期記憶
    ├── memory/            # idle終了したsessionの日次記憶。最初の保存時にagentが作成
    ├── HEARTBEAT.md       # heartbeat checklist
    └── cron.toml          # schedule job
```

`config.toml`では`[memory]` sectionだけが必須です。他sectionとfieldは省略できます。既存configに`[memory]`がなければ起動に失敗するため、次を追加してください。

```toml
[memory]
enabled = true
maintenance_cron = "0 4 * * *"

[discord]
allowed_channel_ids = []
allow_dm = true
```

`enabled`はidle終了前のsession記憶保存と日次整理を一括で切り替えます。cronはprocess local timezoneを使い、設定変更の反映には再起動が必要です。全fieldと検証条件は [SPECの設定](./docs/SPEC.md#14-設定) を参照してください。

scheduleの例です。

```toml
[[jobs]]
id = "daily-summary"
enabled = true
kind = "recurring"
cron = "0 21 * * *"
prompt = "今日の会話を確認して、必要ならDiscordへ要約を送る"
```

## Native setup

```sh
mise install
pnpm install --frozen-lockfile
pnpm run gen
pnpm run build
DISCORD_BOT_TOKEN=... pnpm start
```

`pnpm start`と`node dist/index.mjs`が正式な実行入口です。process manager、log保存、rotation、restartは配置先で設定してください。

開発時は型生成後に次を使います。

```sh
pnpm run dev
```

## Docker setup

DockerはGitを含み、専用non-root userでprocessを起動して、そのuserへpasswordless sudoを設定します。Composeはhostの`./data`をcontainerの`/home/node`へmountします。

```sh
cp .env.example .env
mkdir -p data
# .envのDISCORD_BOT_TOKENを設定する
docker compose up
```

`data`はcontainerのnode userから書き込める必要があります。必要に応じてhost側の所有者と権限を調整してください。追加mountと`TZ`は配置前にCompose設定を確認してください。

## Discordでの開始条件

- `allowed_channel_ids`内では、Luna自身以外の全投稿を常時受け取ります。
- 登録したGuild channelの子threadも常設として扱います。
- 設定外channelとthreadでは、Lunaへのmentionで30分の一時sessionを開始します。
- 親channelの一時sessionは子threadへ継承しません。
- DMは既定で全利用者から受け取ります。
- 人間、他Bot、Webhook、system messageを入力に含めます。

同時turn、queue、turn時間、action失敗follow-upに上限はありません。Bot loop、memory exhaustion、永久に完了しないshutdownを防ぐ仕組みもありません。

## 記憶保存と日次整理

memory機能が有効な場合、会話sessionはidle終了前に同じCodex threadで`memory/YYYY-MM-DD.md`へ会話要約と将来役立つ事項を追記してからarchiveされます。保存中の新着投稿はarchive後の新threadで処理されます。shutdownやturn失敗による終了では保存しません。

設定cronでは専用threadが全日次記憶、`MEMORY.md`、workspaceを読み、記憶とfile配置を整理します。通常threadと同じ権限を持つため、不要と判断したfileの削除や文書の移動・renameが起こります。日次記憶fileは既存pathに残すよう指示されますが、application側の保護pathと排他制御はありません。

Gitが利用できれば、専用threadは必要に応じてworkspaceをrepository化し、`Luna <luna@localhost>`で整理後のcommitを最大一件作ります。pushと空commitは行いません。stage対象、除外対象、messageはagentが判断し、applicationはcommitを検証しません。Gitがなければfile整理だけを続行します。整理の成功・失敗報告だけを目的とするDiscord通知は行いません。

## Logging and monitoring

LunaはJSON Linesをstdoutだけへ出します。file log、rotation、HTTP health endpointはありません。process livenessとexit codeを監視し、non-zero終了時は配置先のprocess managerで再起動してください。

SIGINTまたはSIGTERMでは新規Discord受付、heartbeat timer、schedule tick、日次整理tickを止め、signal前に受理した全処理の自然完了を待ちます。shutdownを理由とするsession記憶保存は開始しません。grace timeoutがないため、終了しないturnがあればprocessも終了しません。

## Development checks

source変更前に固定版Codex CLIから型を生成します。

```sh
pnpm run gen
pnpm run format:check
pnpm run lint
pnpm run knip
pnpm run typecheck
pnpm run test
pnpm run build
docker build -t luna-chat:local .
```

CI gateはformat、lint、knip、typecheck、testです。local実装完了条件にはNode buildとDocker image buildも含みます。generated Codex typeと`dist`はGitで管理しません。

## Manual live E2E

実credentialを使う試験は自動化しません。専用の検証server、検証Bot、隔離した`LUNA_HOME`を用意して次を確認してください。

1. `pnpm install --frozen-lockfile`、型生成、build、全quality gateを通す。
2. 空の検証用`LUNA_HOME`とBot tokenで起動し、初期fileが生成されることを確認する。
3. 常設channelでmentionなしの投稿、設定外channelでmentionから始まる投稿、独立thread、DMを試す。
4. 人間の連投とtyping待機、active turn中の追加投稿を試す。
5. Lunaへsend、reply、file添付、reaction追加・削除、typing開始・停止を依頼する。
6. 存在しないreply、Discord文字数超過、読めないfileを指定し、action failure後のfollow-upを確認する。
7. heartbeat間隔を短い検証値へ変更し、`HEARTBEAT.md`の実行とarchiveを確認する。
8. recurring jobと未来のone-shotを登録し、one-shotが`turn/start`後にfileから消えることを確認する。
9. session idleを短い検証値へ変更し、`memory/YYYY-MM-DD.md`への追記後にarchiveされることを確認する。
10. session記憶保存中に投稿し、archive後の次threadで処理されることを確認する。
11. `maintenance_cron`を近い検証時刻へ変更して再起動し、全日次記憶と`MEMORY.md`の整理、workspaceのfile操作、Git利用時のcommit、thread archiveを確認する。
12. Gitを利用できない検証環境では、日次整理がfile操作だけを完了することを確認する。
13. app-server child processを停止し、active turn失敗、未開始queueの新thread処理、backoffを確認する。
14. SIGTERMを送り、受付停止とdrain順序を確認する。

実Discordへの投稿、mention、添付、host commandが発生するため、production serverや重要dataで実施しないでください。

## Documents

- [SPEC.md](./docs/SPEC.md): 外部動作、権限、設定、既定値、失敗契約の正本
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md): module、state machine、sequence、port/adapter、test契約の正本

このREADMEは導入と運用の入口です。仕様が必要な判断はSPEC、内部実現方法はARCHITECTUREを正とします。
