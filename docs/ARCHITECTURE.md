# Luna アーキテクチャ設計書

本書は、Lunaの内部設計のうち機能をまたぐもの（モジュール構成、依存の方向、会話セッションの状態遷移、起動と終了）を定める。機能ごとの内部設計は、[SPEC.md](./SPEC.md) の一覧にある各ファイルの「内部設計」の節にある。

## 設計方針

Lunaは、単一のNode.jsプロセス内でDiscordとHTTPの会話、自律タスクを並行処理する、モジュラーヘキサゴナルアーキテクチャとして構築される。

1. **外部境界の分離**: Discord、エージェントの実行基盤（pi）、ファイルシステム、システムクロックをドメインおよびアプリケーション層から分離する。
2. **スコープ単位の直列化と並行性**: 会話スコープ内の状態変更は直列化し、異なるスコープ間は並行動作させる。
3. **影響範囲の局所化**: モデルへのリクエストの失敗、ツールの失敗、実行の失敗の影響範囲を分離する。ツールの失敗は実行を止めずにエージェントへ返す。

## システムコンテキスト

```text
Discord Gateway ─► discord ─► conversation ──────────┐
ローカルHTTP ────► http ─────► conversation ──────────┤
                           └──► event executor ───────┼─► AgentRuntimePort ─► pi Agent ─► ChatGPT（openai-codex）／Claude Code CLI（claude-code）
automation sources ──────────► event executor ────────┤        │ セッションごとのツール
Home Assistant ──► home-assistant ─► conversation ──────┤        │
Discord VC ──► voice ─► conversation ───────────────────┤        │
task service（作業エージェント）──────────────────────┘         ▼
      ▲  task_create / task_message / task_cancel          tool（Discord・タスク・HTTP応答・待機）
      └──────────────────────────────────────────────────── と汎用ツール（シェル・ファイル・Web・画像）

ブラウザ ─► dashboard ─► 各モジュールの snapshot / 直近ログ（読み取りのみ）

外部リソース: LUNA_HOME / マウントされたファイルシステム / stdout / ChatGPTのバックエンド / Claude Code CLI（子プロセス）とAnthropic API / Home Assistant（REST・WebSocket）/ TTSエンジン
```

- エージェントループとツールの実行は常にLunaのプロセス内で行う。`claude-code` だけは、モデルとの通信を Claude Code CLI の子プロセスに任せる（[agent.md](./agent.md)）。
- ダッシュボードは、HTTP APIとは別のHonoサーバーとして別ポートで待ち受ける。

## ソースコード構成

```text
src/
├── modules/
│   ├── discord/         # Discord Gateway/REST, Discordツール, 会話委譲
│   │   ├── domain/
│   │   ├── application/
│   │   ├── ports/
│   │   └── adapters/
│   ├── conversation/    # 会話セッション管理, 入力バッチ, アイドルタイマー
│   ├── agent/           # エージェントのセッション（pi）, 汎用ツール, ChatGPTの認証・使用枠, Claude Code のプロバイダ
│   ├── event/           # 共通イベントエンベロープ, ワンショット実行
│   ├── http/            # HTTPイベント受付, 応答ツール, 待機中の応答管理
│   ├── tool/            # ツールの定義と実行元, ツール集合, 待機ツール
│   ├── automation/      # ハートビート, スケジュール, 日次整理, 記録の掃除
│   ├── task/            # バックグラウンドタスク, 作業エージェントの実行, 依頼元への通知
│   ├── intent/          # 話題をきっかけにする予定の照合と発火の記録
│   ├── home-assistant/  # HAのツール, WebSocket購読, 状態変化の起動, Assistの会話エージェント
│   ├── workspace/       # ファイル初期化, 設定読込, cron監視
│   ├── dashboard/       # 状態スナップショットの集約, 閲覧用ページ
│   ├── voice/           # ボイスチャンネルの参加, 聞き取り, 読み上げ
│   └── observability/   # 構造化ログ, 秘匿情報マスク, 直近ログの保持
├── runtime/             # コンポジションルート, エントリポイント, 開発者指示
└── shared/              # 機能に依存しない汎用関数・型
```

各モジュールは必要なレイヤーのみを保持する。モジュール間をまたぐビジネスロジックは、それを実行する上位のアプリケーション層に配置する。

## モジュールの責務

| モジュール       | 主な責務・所有する概念                                                                       | 公開インターフェース（ポート）                                                                                 | 主なアダプター                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `discord`        | メッセージ正規化、スコープ判定、Discordツール、タイピング管理                                | イベント変換、ツールプロバイダ、Discord API呼び出し、Gateway購読                                               | discord.js Gateway/REST                                                                        |
| `conversation`   | セッション状態、入力キュー、アイドル監視、記憶保存、モデル設定                               | `accept`、`acceptFollowUp`、`remember`、`configure`、`endSession`、`typing`、`stopIntake`、`drain`             | Discordコントローラー、履歴取得                                                                |
| `agent`          | エージェントのセッション、再試行、圧縮、記録、汎用ツール、認証と使用枠                       | `open`（セッションの `run`・`steer`・`abort`・`setModel`・`close`）、`listModels`、`status`、`ModelStreamPort` | pi-agent-core、pi-ai、pi-coding-agent、ファイル                                                |
| `event`          | 共通イベント（`LunaEvent`）と入力メッセージへの変換、ワンショット実行                        | `execute`                                                                                                      | なし（EventExecutorがセッションを開いて実行する）                                              |
| `http`           | HTTPイベントの検証、受付、完了待ち応答                                                       | `submit`、`stopIntake`、`drain`                                                                                | Hono、`http_respond` ツール                                                                    |
| `tool`           | ツールの定義、実行元（`ToolOrigin`）、ツール集合、待機                                       | `defineTool`、`createToolSet`（`bind`・`release`）、`OpenAgentSession`                                         | 待機ツール                                                                                     |
| `automation`     | ハートビート、スケジュール、日次整理のイベント発火、checkの判定、記録の掃除                  | `startAutomation`、`stopIntake`、`drain`                                                                       | タイマー、cronスケジューラ、ファイル監視、check子プロセス                                      |
| `task`           | タスク状態、作業エージェントの実行枠と実行の続け方、公開範囲、通知                           | `create`、`message`、`cancel`、`report`、`listFor`、`start`、`stopIntake`、`drain`                             | JSONファイルストア、`task_*` ツール                                                            |
| `intent`         | 話題をきっかけにする予定の照合、発火回数とcooldown                                           | `match`                                                                                                        | `intents.toml`、状態のJSONファイル                                                             |
| `home-assistant` | HAのツール、WebSocketの接続、状態変化の絞り込みとcooldown、Assistの発話と応答待ち            | ツールプロバイダ、`StateChangeWatcher`（`start`・`stop`・`status`）、`AssistService`（`submit`・`stopIntake`） | fetch（REST）、Node.js標準の `WebSocket`、`home-assistant.toml`、Honoのルート                  |
| `workspace`      | ディレクトリ初期化、設定ファイル（TOML）の読み書き・監視、ゴミ箱、skillの使用記録            | 初期化、プロンプト読み込み、スケジュール読み書き                                                               | ファイルシステム、`smol-toml`、Zod                                                             |
| `voice`          | ボイスチャンネルの参加・紐づけ・モード、聞き取りとターン確定、表の返事と割り込み、裏への依頼 | ツールプロバイダ、`VoiceChannelService`（`isBound`・`onBatchSettled`・`stop`）                                 | `@discordjs/voice`、`opusscript`、`sherpa-onnx-node`、TTSエンジン（HTTP）、pi-ai の `classify` |
| `dashboard`      | 各モジュールの状態の集約、閲覧用ページ                                                       | `snapshot`                                                                                                     | Hono（`/`、`/api/snapshot`）                                                                   |
| `observability`  | 構造化ログ出力、ログレベル制御、秘匿情報のマスキング、直近ログの保持                         | ロガーポート、直近ログの一覧                                                                                   | 標準出力（pino、JSON Lines）、メモリ上のリングバッファ                                         |
| `runtime`        | オブジェクトグラフの構築、起動・終了ライフサイクルの配線                                     | プロセスエントリポイント（`citty` のサブコマンド `start`・`login`・`replay`）                                  | シグナルハンドラー                                                                             |

## 依存関係の方向

- ドメイン層は同一モジュール内のアプリケーション層やアダプター層をインポートしない。
- アプリケーション層はドメイン層とポート（インターフェース）のみに依存する。
- アダプター層はポートを実装し、外部ライブラリやI/Oを扱う。

```text
discord      ──► event / tool
http         ──► conversation / event / tool
home-assistant ──► conversation（型のみ） / event（型のみ） / tool
conversation ──► event / tool / agent（型のみ）
automation   ──► event / workspace
event        ──► tool / agent（型のみ）
task         ──► tool / event（型のみ） / agent（型のみ）
tool         ──► agent（型のみ）
dashboard    ──► agent / automation / conversation / event / task / home-assistant / observability（型のみ）
voice        ──► tool / agent（型のみ） / conversation（型のみ） / event（型のみ） / workspace（型のみ）
all          ──► observability
runtime      ──► 全モジュール (composition root)
```

各モジュールは `LoggerPort` に依存する。会話セッション・イベント・ジョブ・タスクの識別子は `child(context)` で束ね、出力は `info`・`warn`・`error` の詳細（常に出す）と本文（`LOG_LEVEL` が `debug` 以下のときだけ標準出力に出す）で渡す。秘匿フィールドは任意の深さで大文字小文字を問わず伏せる必要があり、パス指定の pino の redact では表せないため、自前の直列化で伏せる。

## ドメインモデル

```ts
type ConversationScope =
	| { kind: "guild_channel"; guildId: string; channelId: string }
	| { kind: "guild_thread"; guildId: string; parentChannelId: string; threadId: string }
	| { kind: "dm"; channelId: string; userId: string };

type LunaEvent = {
	id: string;
	type: string;
	source: string;
	subject?: string;
	occurredAt: string;
	data: JsonValue;
};

type ConversationSession = {
	key: string;
	source: string;
	context: JsonValue;
};
```

## 会話セッションの状態遷移

```text
ABSENT
  │ accepted input
  ▼
COLLECTING ── dispatch ready ──► OPENING ──► RUNNING ◄── 実行中の入力は steer
     ▲                                          │ run 完了
     │                                          ▼
     └──── queued input / debounce ◄──────── IDLE
                                                │ idle deadline / end / shutdown
                                                ▼
                                       RUNNING（session_end）
                                                │
                                                ▼
                                            CLOSING ──► ABSENT
```

- 会話スコープごとにアクター（Mailboxパターン）を1つ保持し、状態変更を直列に処理する。
- 実行中に届いた投稿は、キューに積まずにすぐセッションへ steer する。pi はそれを実行中のツール呼び出しの後、次のLLMリクエストの前に入れる。
- `isImmediate(event)` が真の入力（Assistの発話とボイスチャンネルの入力）は、debounce と入力中の待機を飛ばす。
- `RUNNING` の中の再試行待ちと圧縮は、エージェントのセッションの `status()` から読み、ダッシュボードには `retry_wait`・`compacting` として出す。
- `IDLE` に入る時、バックグラウンド実行が残っていればアイドルタイマーの代わりに `waitForBackground()` を待つ。通知が届けば同じセッションで `RUNNING` に戻り、通知なしにすべて止まっていればアイドルタイマーを始める。待っている間に入力が届いた場合は、トークンを進めて待ちの結果を捨てる。
- 記憶保存（`session_end`）を始める前に `stopBackground()` を呼ぶ。
- アクターはセッションが知っているIDの集合を持つ。受け付けた入力と初回コンテキストのイベントID、`remember` で渡されたIDを加え、セッションを閉じる時にキューに残った入力のIDだけにする。`acceptFollowUp(input, targetId)` は対象IDを知っていて終了処理に入っていない時だけ、`accept` と同じ経路で入力を扱う。アクターがなければ何もせず、セッションを開かない。

## 起動と終了

### 起動

1. 環境変数の検証
2. `LUNA_HOME` および初期ワークスペースファイルの作成・検証
3. `config.toml` と `cron.toml` の読み込み
4. ログ・Discordクライアント・RESTアダプターの初期化。`[voice]` があれば音声認識とVADのモデルを読み込む
5. 資格情報ストアとモデルのカタログの準備、`[models]` の検証、エージェントのランタイムの作成、使用枠の取得の開始
6. Discordへの接続ログイン
7. 保存済みタスクの読み込み、未配送通知の再配送、待機タスクの実行開始（オートメーションのイベントがタスクを作成できるよう先に行う）
8. 期限切れの記録の削除をバックグラウンドで開始
9. Gateway受信、HTTP API（Assistのルートを含む）、ダッシュボード、ハートビート、日次整理、cron監視、HAのWebSocket接続の開始

### 終了

1. SIGINT / SIGTERM を受信
2. Gatewayからの新規メッセージ、HTTPイベントとAssistの受付、HAの状態変化による起動、新規タイマー発火を停止し、実行中のバックグラウンドタスクを中断してキューへ戻す。イベント実行のバックグラウンド実行を止め、ボイスチャンネルから出る
3. 受信済みのキュー、実行中のスケジュールのcheck、および実行中の処理がすべて自然完了するのを待機
4. 正常完了した会話セッションの記憶保存を実行
5. 完了したセッションを閉じる（記録を確定し、汎用ツールのプロセスを終わらせる）
6. 待機中のHTTPリクエストとAssistのリクエストの完了を確認し、HTTPサーバー、ダッシュボード、タイピングリース、ファイル監視、使用枠の取得、HAのWebSocket接続、Discord接続を停止
7. ログをフラッシュして終了

## ビルド

`pnpm run build` により、`src/index.ts` をESMの `dist/index.mjs` へバンドルする。依存パッケージはバンドルせず、実行時に `node_modules` から読み込む。`package.json` の `bin`（`luna-chat`）はこのファイルを指す。初期テンプレートは、エントリポイントの位置を基準にパッケージ内の `templates/` から読み込む。
