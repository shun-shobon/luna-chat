# Luna

Lunaは、Discordを入口にCodexを動かす個人用workspace agentです。Discordの会話、host上のfilesystemとcommand、heartbeat、時刻指定jobを一つのLuna workspaceへ接続します。

> 現在のbranchは再設計文書の承認段階です。このREADME、[仕様](./docs/SPEC.md)、[architecture](./docs/ARCHITECTURE.md)は切替先の設計を表し、実装はまだ旧composition rootのままです。設計一括承認後に実装を切り替えます。

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
- Node.js `24.14.0`
- pnpm `10.30.3`

Windows、公開CLI、systemd unit、launchd plist、HTTP health endpointは提供しません。

## 必要なもの

- Discord Bot token
- Discord Gatewayのmessage content、Guild/DM message、typingに必要なintent
- Codex認証を保存できる永続directory
- native実行ではNode.jsとpnpm
- Docker実行ではDocker EngineとCompose

Codex executableはpnpmで固定した`@openai/codex`だけを使います。hostのPATHにある別versionへfallbackしません。

初回起動前に、Luna専用Codex homeへ認証します。nativeではdependency install後に次を実行し、browser flowを完了してください。

```sh
mkdir -p "$HOME/.luna/codex"
CODEX_HOME="$HOME/.luna/codex" ./node_modules/.bin/codex login
CODEX_HOME="$HOME/.luna/codex" ./node_modules/.bin/codex login status
```

headlessなDocker hostではdevice authを使えます。Composeの永続volumeが同じ`LUNA_HOME`へmountされることを先に確認してください。

```sh
docker compose run --rm luna-chat codex login --device-auth
docker compose run --rm luna-chat codex login status
```

## Environment

| 変数                | 必須   | 既定値      | 説明                                                            |
| ------------------- | ------ | ----------- | --------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | はい   | なし        | Discord Bot token。Codex child processへ渡しません。            |
| `LUNA_HOME`         | いいえ | `~/.luna`   | 絶対pathだけを指定できます。                                    |
| `LOG_LEVEL`         | いいえ | `info`      | `trace` / `debug` / `info` / `warn` / `error`。                 |
| `TZ`                | いいえ | process依存 | scheduleに使うNode.js local timezone。Dockerは未指定時UTCです。 |

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
    ├── HEARTBEAT.md       # heartbeat checklist
    └── cron.toml          # schedule job
```

`config.toml`の全fieldは省略できます。空fileでは常設channelなし、DM有効、heartbeat有効です。

```toml
[discord]
allowed_channel_ids = []
allow_dm = true
```

全field、既定値、検証条件は [SPECの設定](./docs/SPEC.md#13-設定) を参照してください。

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
corepack enable
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

Dockerは専用non-root userでprocessを起動し、そのuserへpasswordless sudoを設定します。標準ではLuna homeだけをmountし、追加directoryはComposeで明示してください。host rootを自動mountしません。

```sh
docker compose build
DISCORD_BOT_TOKEN=... docker compose up
```

永続化先、追加mount、`TZ`は配置前にCompose設定を確認してください。

## Discordでの開始条件

- `allowed_channel_ids`内では、Luna自身以外の全投稿を常時受け取ります。
- 登録したGuild channelの子threadも常設として扱います。
- 設定外channelとthreadでは、Lunaへのmentionで30分の一時sessionを開始します。
- 親channelの一時sessionは子threadへ継承しません。
- DMは既定で全利用者から受け取ります。
- 人間、他Bot、Webhook、system messageを入力に含めます。

同時turn、queue、turn時間、action失敗follow-upに上限はありません。Bot loop、memory exhaustion、永久に完了しないshutdownを防ぐ仕組みもありません。

## Logging and monitoring

LunaはJSON Linesをstdoutだけへ出します。file log、rotation、HTTP health endpointはありません。process livenessとexit codeを監視し、non-zero終了時は配置先のprocess managerで再起動してください。

SIGINTまたはSIGTERMでは新規Discord受付、heartbeat timer、schedule tickを止め、signal前に受理した全処理の自然完了を待ちます。grace timeoutがないため、終了しないturnがあればprocessも終了しません。

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
docker compose build
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
9. session idleを短い検証値へ変更し、archive後の次投稿が新threadになることを確認する。
10. app-server child processを停止し、active turn失敗、未開始queueの新thread処理、backoffを確認する。
11. SIGTERMを送り、受付停止とdrain順序を確認する。

実Discordへの投稿、mention、添付、host commandが発生するため、production serverや重要dataで実施しないでください。

## Documents

- [SPEC.md](./docs/SPEC.md): 外部動作、権限、設定、既定値、失敗契約の正本
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md): module、state machine、sequence、port/adapter、test契約の正本

このREADMEは導入と運用の入口です。仕様が必要な判断はSPEC、内部実現方法はARCHITECTUREを正とします。
