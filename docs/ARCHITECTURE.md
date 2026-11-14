# Luna アーキテクチャ設計書

## 1. 設計方針と目標

Lunaは、単一のNode.jsプロセス内でDiscordとHTTPの会話、自律タスクを並行処理する、モジュラーヘキサゴナルアーキテクチャ（クリーンアーキテクチャ）として構築される。

### 主要な原則

1. **外部境界の分離**: Discord、エージェントの実行基盤（pi）、ファイルシステム、システムクロックをドメインおよびアプリケーション層から完全に分離する。
2. **スコープ単位の直列化と並行性**: 会話スコープ内の状態変更は直列化し、異なるスコープ間は完全に並行動作させる。
3. **外部入力の厳格な検証**: 未検証の外部入力はシステムの境界でZod等を用いて検証し、内部に `unknown` や未検証の型を持ち込まない。
4. **影響範囲の局所化**: モデルへのリクエストの失敗、ツールの失敗、実行の失敗の影響範囲を明確に分離する。ツールの失敗は実行を止めずにエージェントへ返す。
5. **フレームワーク非依存**: 内部イベントバスやDIフレームワークは用いず、明示的なポートの呼び出しと依存性注入を行う。

## 2. システムコンテキスト

```text
Discord Gateway ─► discord ─► conversation ──────────┐
ローカルHTTP ────► http ─────► conversation ──────────┤
                           └──► event executor ───────┼─► AgentRuntimePort ─► pi Agent ─► ChatGPT（openai-codex）
automation sources ──────────► event executor ────────┤        │ セッションごとのツール
Home Assistant ──► home-assistant ─► conversation ──────┤        │
task service（作業エージェント）──────────────────────┘         ▼
      ▲  task_create / task_message / task_cancel          tool（Discord・タスク・HTTP応答・待機）
      └──────────────────────────────────────────────────── と汎用ツール（シェル・ファイル・Web・画像）

ブラウザ ─► dashboard ─► 各モジュールの snapshot / 直近ログ（読み取りのみ）

Lunaプロセス内: 上記各モジュール、observability、runtime
外部リソース: LUNA_HOME / マウントされたファイルシステム / stdout / ChatGPTのバックエンド / Home Assistant（REST・WebSocket）
```

- **エージェントの実行**: Lunaのプロセス内で、セッションごとに pi の `Agent` を1つ持つ。認証とモデルのカタログを持つ pi-ai の `Models` は全セッションで共有する。子プロセスやRPCは使わない。
- **ツール**: エージェントが呼んだ時点で、同じプロセス内で実行する。
- **HTTP API**: Nativeでは `127.0.0.1` にバインドする。Docker Composeではコンテナ内の `0.0.0.0` にバインドし、ホストの `127.0.0.1` にのみポートを公開する。
- **ダッシュボード**: HTTP APIとは別のHonoサーバーとして別ポートで待ち受ける。バインド先はHTTP APIと同じく環境変数で選ぶ。
- **デスクトップ**: Lunaのプロセスの外にある任意の systemd サービス群（`deploy/desktop/`）。Lunaのコードは参照せず、エージェントがシェルから skill `luna-desktop` のスクリプトとCDPで使う。

## 3. ソースコード構成

```text
src/
├── modules/
│   ├── discord/         # Discord Gateway/REST, Discordツール, 会話委譲
│   │   ├── domain/
│   │   ├── application/
│   │   ├── ports/
│   │   └── adapters/
│   ├── conversation/    # 会話セッション管理, 入力バッチ, アイドルタイマー
│   ├── agent/           # エージェントのセッション（pi）, 汎用ツール, ChatGPTの認証・使用枠
│   ├── event/           # 共通イベントエンベロープ, ワンショット実行
│   ├── http/            # HTTPイベント受付, 応答ツール, 待機中の応答管理
│   ├── tool/            # ツールの定義と実行元, ツール集合, 待機ツール
│   ├── automation/      # ハートビート, スケジュール, 日次整理, 記録の掃除
│   ├── task/            # バックグラウンドタスク, 作業エージェントの実行, 依頼元への通知
│   ├── intent/          # 話題をきっかけにする予定の照合と発火の記録
│   ├── home-assistant/  # HAのツール, WebSocket購読, 状態変化の起動, Assistの会話エージェント
│   ├── workspace/       # ファイル初期化, 設定読込, cron監視
│   ├── dashboard/       # 状態スナップショットの集約, 閲覧用ページ
│   └── observability/   # 構造化ログ, 秘匿情報マスク, 直近ログの保持
├── runtime/             # コンポジションルート, エントリポイント
└── shared/              # 機能に依存しない汎用関数・型（日付整形、JSON値、Honoサーバーの起動、アトミック書き込み、直列化キュー、実行中の処理の追跡）
```

各モジュールは必要なレイヤーのみを保持する。モジュール間をまたぐビジネスロジックは、それを実行する上位のアプリケーション層に配置する。

## 4. モジュールの責務 (Capability Ownership)

| モジュール       | 主な責務・所有する概念                                                            | 公開インターフェース（ポート）                                                                                 | 主なアダプター                                                                |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `discord`        | メッセージ正規化、スコープ判定、Discordツール、タイピング管理                     | イベント変換、ツールプロバイダ、Discord API呼び出し、Gateway購読                                               | discord.js Gateway/REST                                                       |
| `conversation`   | セッション状態、入力キュー、アイドル監視、記憶保存、モデル設定                    | `accept`、`configure`、`endSession`、`typing`、`stopIntake`、`drain`                                           | Discordコントローラー、履歴取得                                               |
| `agent`          | エージェントのセッション、再試行、圧縮、記録、汎用ツール、認証と使用枠            | `open`（セッションの `run`・`steer`・`abort`・`setModel`・`close`）、`listModels`、`status`                    | pi-agent-core、pi-ai、pi-coding-agent、ファイル                               |
| `event`          | 共通イベント（`LunaEvent`）と入力メッセージへの変換、ワンショット実行             | `execute`                                                                                                      | なし（EventExecutorがセッションを開いて実行する）                             |
| `http`           | HTTPイベントの検証、受付、完了待ち応答                                            | `submit`、`stopIntake`、`drain`                                                                                | Hono、`http_respond` ツール                                                   |
| `tool`           | ツールの定義、実行元（`ToolOrigin`）、ツール集合、待機                            | `defineTool`、`createToolSet`（`bind`・`release`）、`OpenAgentSession`                                         | 待機ツール                                                                    |
| `automation`     | ハートビート、スケジュール、日次整理のイベント発火、checkの判定、記録の掃除       | `startAutomation`、`stopIntake`、`drain`                                                                       | タイマー、cronスケジューラ、ファイル監視、check子プロセス                     |
| `task`           | タスク状態、作業エージェントの実行枠と実行の続け方、公開範囲、通知                | `create`、`message`、`cancel`、`report`、`listFor`、`start`、`stopIntake`、`drain`                             | JSONファイルストア、`task_*` ツール                                           |
| `intent`         | 話題をきっかけにする予定の照合、発火回数とcooldown                                | `match`                                                                                                        | `intents.toml`、状態のJSONファイル                                            |
| `home-assistant` | HAのツール、WebSocketの接続、状態変化の絞り込みとcooldown、Assistの発話と応答待ち | ツールプロバイダ、`StateChangeWatcher`（`start`・`stop`・`status`）、`AssistService`（`submit`・`stopIntake`） | fetch（REST）、Node.js標準の `WebSocket`、`home-assistant.toml`、Honoのルート |
| `workspace`      | ディレクトリ初期化、設定ファイル（TOML）の読み書き・監視、ゴミ箱、skillの使用記録 | 初期化、プロンプト読み込み、スケジュール読み書き                                                               | ファイルシステム、`smol-toml`、Zod                                            |
| `dashboard`      | 各モジュールの状態の集約、閲覧用ページ                                            | `snapshot`                                                                                                     | Hono（`/`、`/api/snapshot`）                                                  |
| `observability`  | 構造化ログ出力、ログレベル制御、秘匿情報のマスキング、直近ログの保持              | ロガーポート、直近ログの一覧                                                                                   | 標準出力（pino、JSON Lines）、メモリ上のリングバッファ                        |
| `runtime`        | オブジェクトグラフの構築、起動・終了ライフサイクルの配線                          | プロセスエントリポイント（`citty` のサブコマンド `start`・`login`・`replay`）                                  | シグナルハンドラー                                                            |

## 5. 依存関係の方向

- ドメイン層は同一モジュール内のアプリケーション層やアダプター層をインポートしない。
- アプリケーション層はドメイン層とポート（インターフェース）のみに依存する。
- アダプター層はポートを実装し、外部ライブラリやI/Oを扱う。
- モジュール間の連携は、公開されたアプリケーションポートを直接呼び出す。循環参照は避ける。

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
all          ──► observability
runtime      ──► 全モジュール (composition root)
```

- 各モジュールは `LoggerPort` に依存する。会話セッション・イベント・ジョブ・タスクの識別子は `child(context)` で束ね、出力は `info`・`warn`・`error` の詳細（常に出す）と本文（`LOG_LEVEL` が `debug` 以下のときだけ標準出力に出す）で渡す。標準出力への書き出しは pino が担う。秘匿フィールドは任意の深さで大文字小文字を問わず伏せる必要があり、パス指定の pino の redact では表せないため、自前の直列化で伏せる。

## 6. ドメインモデルと状態管理

### 6.1 会話スコープ (ConversationScope)

```ts
type ConversationScope =
	| { kind: "guild_channel"; guildId: string; channelId: string }
	| { kind: "guild_thread"; guildId: string; parentChannelId: string; threadId: string }
	| { kind: "dm"; channelId: string; userId: string };
```

### 6.2 共通イベントとセッション

```ts
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

### 6.3 セッション状態遷移 (Session State Machine)

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
- `RUNNING` の中の再試行待ちと圧縮は、エージェントのセッションの `status()` から読み、ダッシュボードには `retry_wait`・`compacting` として出す。

## 7. 実行とツールのオーケストレーション

```text
検証済み入力
     │
     ├─ セッションを開く: OpenAgentSession(origin, model?)
     │     ├─ システムプロンプト = 種類ごとの開発者指示 + skill一覧 + LUNA.md + MEMORY.md（作業エージェントは後ろ2つを除く）
     │     └─ ツール = ToolSet.bind({ ownerId, origin }) + 汎用ツール
     │
     ├─ run([種類付きメッセージ…])
     │     ├─ モデルがツールを呼ぶ → その場で実行して結果を返す（同じ応答の呼び出しは並行）
     │     ├─ 実行中の入力は steer で次のリクエストの前に入る
     │     └─ 一時的な失敗は同じセッションの続きから再実行（アダプター内）
     │
     ├─ ToolSet.release(ownerId)  # タイピングと待機の解放
     │
     └─ 完了 / 失敗 / 中断を実行元へ返す
```

- 実行元（`ToolOrigin`: 会話セッション、イベント、タスク）と `ownerId` はセッションを開くときにツールへ束ねる。`task_create` や `task_report` は、エージェントの入力ではなくこの実行元で依頼元・報告元を決める。
- `defineTool` はzodの入力スキーマで1回だけ検証し、`describeTarget` でログとダッシュボード用の対象を作る。パラメータのJSON Schemaは `z.toJSONSchema` で作る。ツール名は集合の中で一意でなければならない。
- ツールの失敗（検証エラー・例外）は `isError` の結果としてエージェントへ返し、実行は止めない。成功と失敗は `tool.succeeded`・`tool.failed` としてログに残す。
- 最終応答の本文はどこにも送らない。Discordへの発言はツールだけで行う。
- `http_respond` は `request_id` をキーにステータスとJSON本文を一時保存する。ワンショット実行または会話の実行が完了した時点で、待機中のHTTPリクエストを解決する。会話側は実行に入れたイベントID（最初のバッチと steer したもの）を追跡し、実行の完了時に通知する。

## 8. エージェントのアダプター（pi）

### 8.1 セッション

- `PiAgentRuntime` は `AgentRuntimePort` を実装し、`open(spec)` ごとに pi の `Agent` を作る。pi-ai の `Models`（openai-codex プロバイダと資格情報ストア）は全セッションで共有する。
- 入力は独自ロールのメッセージとして記録し、`convertToLlm` で `<luna_input kind="...">` の user メッセージにする。
- `sessionId`（openai-codex の `prompt_cache_key` と WebSocket の接続キー）はセッションごとに固定し、キャッシュを効かせる。
- Luna のツールは pi の AgentTool に変換して渡す。汎用ツールは `spec.harnessTools` に応じてアダプターが作る（シェル、`read`/`edit`/`write`、`view_image`、`web_run`、`image_gen`）。

### 8.2 失敗と再試行

- pi の Agent は自動では再試行せず、既定ではタイムアウトも持たない。`streamFn` を包んで `request_timeout_ms` と `maxRetries: 0` を渡す。
- 失敗の種類は、pi のエラー文字列ではなく、レスポンスのHTTPステータスとプロバイダの生のイベントで判定する。一時的な失敗は、エラーで終わったアシスタントメッセージを記録から外して `continue()` で再開する。待機中の steer はキューに残る。
- 待機時間は 15秒・60秒・180秒（`TURN_RETRY_DELAYS_MS` 相当）。使用上限・認証・それ以外の失敗は再試行しない。

### 8.3 圧縮と記録

- 直近の assistant の `usage` が文脈長から予約分を引いた値を超えたら、`[models.compaction]` のモデルで切り口より前を要約する（pi-coding-agent の `findCutPoint` と `generateSummaryWithUsage`）。切り口と要約はアダプターが保持し、`transformContext` で毎回のリクエストを「システム → 要約 → 切り口以降」に置き換える。記録（`agent.state.messages`）は書き換えない。
- 記録は `message_end` ごとにJSONLへ追記する。先頭の system メッセージは `message_end` で出ないため、開いた時点で書く。
- 最終更新から保持期間を過ぎた記録は `RetentionCleaner` が定期的に削除する。同じクリーナーを、ワークスペースのゴミ箱（`WorkspaceTrash`）の日付フォルダの削除にも使う。長く開いているセッションは開いた日のファイルに追記し続けるため、日付ではなく更新時刻で判断する。

### 8.4 認証と使用枠

- 資格情報は自前の `CredentialStore`（ファイル、0600、一時ファイルからの rename、プロバイダごとの直列化）に保存する。トークンの更新は pi-ai がリクエストの直前に行う。
- ChatGPTのバックエンド（`wham/usage`、`codex/alpha/search`、`codex/images/generations`）は、同じ資格情報で直接呼ぶ。
- 使用枠は定期的に取得し、`AgentRuntimeStatus.usage` と `LUNA_HOME/state/usage.json` に反映する。

### 8.5 skillの使用記録

- 汎用ツールのうち `read` と `exec_command` を包み、引数に含まれる `.agents/skills/<名前>/SKILL.md` を `SkillUsageStore` に記録する。書き込みはプロセス内で直列化し、一時ファイルからの rename で置き換える。失敗はログに残してツールの実行は止めない。

### 8.6 再生

- `luna-chat replay`（`src/runtime/replay.ts`）は、常駐プロセスとは別のプロセスで `PiAgentRuntime` を作り、場面ごと・指示の組ごとにセッションを開いて閉じる。会話の開発者指示は常駐側と同じ `SESSION_DEVELOPER_INSTRUCTIONS` を使う。
- Lunaのツールは本物の定義を、ポートだけ記録用の偽物に差し替えて組み立てる。汎用ツールは `createReplayHarnessTools` が、読み取りとWeb検索だけ本物、それ以外を記録して成功を返すスタブにする。
- 記録は一時ディレクトリへ書き、終了時に消す。本物の会話記録に混ぜると、ルナが次に記録を見直す時に再生を本物の会話と取り違えるため。

## 9. 話題をきっかけにする予定（intent モジュール）

- `ConversationCoordinator` は実行に渡す入力を組み立てる時と steer する時に、`ConversationIntentPort.match(events)` の結果を該当メッセージの後に加える。
- `IntentMatcher`（application）はイベントから人のDiscordメッセージだけを取り出し、`findFiringIntents`（domain）で期限・発火回数・cooldown・キーワードを判定する。`IntentFileStore`（adapter）は `intents.toml` を毎回読み、発火の状態を `LUNA_HOME/state/intents-state.json` に書く。予定の読み込みに失敗した時はログに残して発火させず、会話は止めない。

## 9.1 Home Assistant（home-assistant モジュール）

```text
HA REST ◄── HomeAssistantRestClient ◄── ha_* ツール
HA WebSocket ◄─► HomeAssistantConnection ──state_changed──► StateChangeWatcher ──accept──► ConversationCoordinator
                     ▲ 登録情報（area 指定時）               │ home-assistant.toml（更新時刻で読み直し）
                     └──── ha_list_entities                  ▼ cooldown（メモリ）
ha-luna ──POST /home-assistant/conversation──► AssistService ──accept──► ConversationCoordinator（集約なし）
        ◄──────────── speech ──────────────── AssistResponseRegistry ◄── assist_respond ツール
```

- `HomeAssistantConnection` は1本のWebSocketで認証・購読・ping・再接続を担い、`id` で応答を対応づける要求（登録情報の取得）も同じ接続で送る。再接続は待ち時間の表に従って自分でタイマーを仕掛け、`stop` で止める。接続状態はダッシュボード用に保持する。
- `StateChangeWatcher`（application）は受けた状態変化を `findStateChangeTrigger`（domain）で判定し、`ConversationCoordinator.accept` で `home_assistant:state_changes` の会話へ渡す。`home-assistant.toml` の読み込みは `WatchConfigPort` 越しで、アダプターは更新時刻が変わった時だけ読み直す。毎回のファイル読みを避けるのは、`state_changed` がセンサーの数だけ頻繁に届くため。
- Assistの会話は集約の待機をしない。`ConversationCoordinator` の `debounceMs` をセッションの関数とし、コンポジションルートがAssistのセッションに0を返す。
- `AssistResponseRegistry` は `assist_respond` の時点で応答待ちのPromiseを解決する。`http_respond` と違い実行の完了を待たないのは、音声の応答待ちを縮め、返答の後も実行を続けられるようにするため。実行の完了は `onBatchSettled` で受け、未応答なら `speech: null` または失敗で解決する。
- ルートはHTTPイベントAPIと同じHonoアプリに `registerAssistRoute` で加える。JSONの読み取りとContent-Typeの判定は `shared/hono-server` の共通関数を使う。

## 9.2 Discord アダプター

- **Gateway**: `messageCreate` やタイピングイベントを購読し、正規化されたドメインイベントへ変換する。
- **スラッシュコマンド**: `/luna` コマンドを受け付け、セッション設定やチャンネルの許可リスト更新を処理する。
- **Discordツール**: 読み取り（履歴、チャンネル一覧、ユーザー、絵文字）と書き込み（送信・返信、リアクション、タイピング）と会話委譲を1つのツールプロバイダにまとめる。作業エージェントには読み取りだけのプロバイダを渡す。
- **会話委譲**: バックグラウンドの実行（ハートビート等）がDiscord上で対話を始めたい場合、自身で直接投稿せず、対象スコープの会話セッションへイベントを委譲して処理を委ねる。
- **タイピング管理**: `start_typing` で始めたタイピング表示を維持し、`stop_typing` または実行の完了（`release`）で確実に解放する。

HTTPアダプターは `/events` のJSONをZodで検証し、LunaEventを生成する。`one_shot` はEventExecutorへ、`conversation` は `http:<session_id>` の会話セッションへ直接渡す。HTTP会話の初回履歴は空とする。受付停止中は503を返し、受理済みワンショット実行は終了時にdrainする。

## 10. ワークスペースと設定管理

- 初回起動時に `LUNA_HOME` 配下の初期ディレクトリ構造とデフォルト設定ファイルを生成する。
- 設定ファイル（`config.toml`, `cron.toml`）は `smol-toml` と Zod により厳格にパース・検証する。
- `cron.toml` の変更はファイル監視によりリアルタイムに検知され、プロセスの再起動なしでスケジュールが更新される。ワンショットタスクは実行開始直後にファイルから自動削除される。

## 11. オートメーション

ハートビート、スケジュール、日次整理は、それぞれ独立したイベントソースとして動作し、共通のワンショットエグゼキュータを呼び出す。

- **ハートビート**: ランダムな時間間隔で `HEARTBEAT.md` と `AGENDA.md` を読み込み、定期チェックとアジェンダの一手を進める。アジェンダはワークスペースのMarkdownとして持ち、構造の検証はしない（エージェントが読み書きする文書として扱う）。
- **スケジュール**: cron定義または指定日時に基づき、登録されたプロンプトを実行する。各発火を `ActiveExecutionSet` で追跡し、同じジョブの発火同士も直列化しない。
- **check**: `ScheduleController` は `AutomationCheckRunnerPort` だけに依存し、出力の空判定・切り詰め・ログ記録を担う。`ChildProcessCheckRunner` は `/bin/sh -c` を独立したプロセスグループで起動し、タイムアウト時はグループ全体へシグナルを送る。暴走した出力でメモリを使い切らないよう、標準出力は先頭、標準エラー出力は末尾をそれぞれ64000文字まで保持する。checkは発火の実行の一部として追跡されるため、`drain` は実行中のcheckと後続のエージェントの実行を待つ。
- **日次整理**: 定期cronにより起動し、記憶の統合やファイルの整理を行った後、Gitが利用可能であればローカルコミットを作成する。
- **記録の掃除**: `TranscriptRetentionCleaner` が起動時と一定間隔で `TranscriptPrunerPort.prune` を呼び、保持期間を過ぎたセッションの記録を削除する。

## 11.1 バックグラウンドタスク

```text
依頼元(会話/イベント) ──task_create──► TaskService ──queue──► 作業セッション(OpenAgentSession)
        ▲                                 │  run(task_assignment) ─► task_report ツール
        │ luna.task.reported.v1           │  steer(task_message)
        └──── TaskDeliveryPort ◄──────────┘  abort(cancel / shutdown)
```

- `TaskService` はタスクをメモリ上の `Map` で保持し、更新のたびにタスクごとに直列化した書き込みで `TaskStorePort` へ保存する。
- 作業セッションの開始は実行枠（`max_concurrent`）で制限する。`question` で待機したセッションはプロセス内の `parked` 表に保持し、メッセージが届いたら同じセッションで再開する。
- 作業セッションのツール集合は、Discordの読み取り、`task_report`、`wait` で構成する（汎用ツールはアダプターが加える）。
- 実行の完了ごとに、終了報告の有無、未配送のメッセージ、`waiting_input` を見て続け方を決める。終了報告がなければ一度だけ `task_check` を渡す。
- 通知は `TaskDeliveryPort` を介して、会話には `ConversationCoordinator.accept`、イベント起点にはEventExecutorの新規実行として渡す。配送の受理時刻を報告に記録し、未受理の通知は起動時に再配送する。
- 会話とイベントの入力に同梱するタスク一覧は、`ConversationTaskBoardPort` / `EventTaskBoardPort` を介して `TaskService.listFor` から取得する。conversation・eventモジュールはtaskモジュールに依存しない。
- 取消・シャットダウンでは、作業セッションの `ownerId` で `ToolSet.release` を呼んで `wait` を打ち切り、セッションを `abort` する。シャットダウンはループ・配送・保存の完了を待つ。

## 11.2 状態の可視化（ダッシュボード）

```text
ConversationCoordinator.snapshot ─┐
EventExecutor.snapshot ───────────┤
TaskService.snapshot ─────────────┤
AutomationService.snapshot ───────┼─► DashboardService.snapshot ─► GET /api/snapshot ─► ページ（3秒ごとに取得）
AgentRuntimePort.status ──────────┤
StateChangeWatcher.status ────────┤
RecentLogBuffer.list ─────────────┘
```

- 各モジュールはアプリケーション層に読み取り専用の `snapshot`（エージェントのアダプターは `status`）を持ち、状態の型はdomain/ports層に置く。`DashboardSourcePort` はそれらを呼ぶ関数の集まりで、コンポジションルートが配線する。状態の変更通知の仕組みは持たず、取得のたびにメモリ上の状態を読む。
- 会話アクターはフェーズを変えるたびに開始時刻を記録する（`#enter`）。EventExecutorは実行中のイベントとフェーズを保持し、完了・失敗で外す。
- ハートビートは次のタイマーを仕掛けた時点の予定時刻を保持する。日次整理とスケジュールの次回時刻は `ScheduledAutomationJob.nextRunAt`（cronライブラリの `nextDate`）から求める。
- 直近の出来事は、標準出力のロガーと同じ呼び出しを受ける `RecentLogBuffer` が保持する。標準出力と違い `LOG_LEVEL` に関係なくinfo以上を本文付きで残すため、ログレベルを上げずに会話の中身を追える。秘匿フィールドのマスクは標準出力と同じ直列化を使う。
- ページは単一のHTML文字列（`dashboard-page.ts`）で、外部ライブラリを使わない。表示する文字列はすべて `textContent` で入れ、Discordの本文をHTMLとして解釈しない。

## 12. 起動とシャットダウンシーケンス

### 起動 (Startup)

1. 環境変数の検証
2. `LUNA_HOME` および初期ワークスペースファイルの作成・検証
3. `config.toml` と `cron.toml` の読み込み
4. ログ・Discordクライアント・RESTアダプターの初期化
5. 資格情報ストアとモデルのカタログの準備、`[models]` の検証、エージェントのランタイムの作成、使用枠の取得の開始
6. Discordへの接続ログイン
7. 保存済みタスクの読み込み、未配送通知の再配送、待機タスクの実行開始（オートメーションのイベントがタスクを作成できるよう先に行う）
8. 期限切れの記録の削除をバックグラウンドで開始
9. Gateway受信、HTTP API（Assistのルートを含む）、ダッシュボード、ハートビート、日次整理、cron監視、HAのWebSocket接続の開始

### 終了 (Shutdown)

1. SIGINT / SIGTERM を受信
2. Gatewayからの新規メッセージ、HTTPイベントとAssistの受付、HAの状態変化による起動、新規タイマー発火を停止し、実行中のバックグラウンドタスクを中断してキューへ戻す
3. 受信済みのキュー、実行中のスケジュールのcheck、および実行中の処理がすべて自然完了するのを待機
4. 正常完了した会話セッションの記憶保存を実行
5. 完了したセッションを閉じる（記録を確定し、汎用ツールのプロセスを終わらせる）
6. 待機中のHTTPリクエストとAssistのリクエストの完了を確認し、HTTPサーバー、ダッシュボード、タイピングリース、ファイル監視、使用枠の取得、HAのWebSocket接続、Discord接続を停止
7. ログをフラッシュして終了

## 13. テスト方針

コードカバレッジの数値目標は設定せず、各レイヤーの境界における入出力や状態遷移のテストを重視する。

| テストレイヤー           | 検証対象                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ドメイン単体テスト       | セッション状態遷移、禁止遷移、イベントエンベロープ、入力メッセージへの変換、ツールの入力スキーマ                                                            |
| アプリケーション層テスト | バッチ集約・steerの入る位置、記憶保存、タスクの続け方、ハートビート、日次整理                                                                               |
| アダプター層テスト       | Gateway、REST、ツール、エージェントのセッション（pi の faux プロバイダ）、ChatGPTのバックエンド（fetch のモック）、プロセス制御、ファイルシステム、タイマー |
| 異常系マトリクス         | タイムアウト、不正レスポンス、通信切断、使用上限、認証の失敗、例外発生時の挙動                                                                              |
| 並行性テスト             | スコープごとの直列化、複数スコープ間の並行実行、シャットダウン時のドレイン処理                                                                              |
| 結合テスト               | モックを用いた起動からシャットダウンまでの一連の統合フロー                                                                                                  |
| ツール集合のテスト       | 本番の全ツールプロバイダのツール名が重複せず、入力スキーマからJSON Schemaを生成できること                                                                   |
| 手動E2Eテスト            | 実Discordおよび実ChatGPTを用いた対話動作の確認                                                                                                              |

## 14. ビルドとリリースパイプライン

- **ローカルビルド**: `pnpm run build` により、`src/index.ts` をESMの `dist/index.mjs` へバンドルする。依存パッケージはバンドルせず、実行時に `node_modules` から読み込む。`package.json` の `bin`（`luna-chat`）はこのファイルを指す。初期テンプレートは、エントリポイントの位置を基準にパッケージ内の `templates/` から読み込む。
- **CI品質ゲート**: GitHub Actions上でフォーマット、リント、未使用コード検出（knip）、型チェック（typecheck）、テストを自動実行し、すべてが通過することをmainブランチへのマージ条件とする。
- **リリースワークフロー**: `.github/workflows/release.yml` に手動実行とPRマージ後の処理を集約する。準備ジョブは共通setupでpnpmと依存関係を用意する。`shun-shobon/easy-release` の `prepare` が `.github/easy-release.json` を読み、最新の安定版Gitタグからバージョンを更新し、`updateCommand` の `pnpm format` で整形した変更をPRに含める。マージ後は `draft` が準備PRとバージョンを検証し、タグとドラフトReleaseを作成する。`ready` が `true` の場合だけ、出力された `commit` をDockerのビルドに、`tag` をイメージタグに使う。DockerはLinuxのamd64・arm64を対象とし、GitHub Artifact Attestationsを付与する。ビルドジョブの成功後にDockerの `latest` を更新し、`publish` に `release-id`・`tag`・`commit` を渡して公開する。リリース処理は共通のconcurrencyグループで直列化する。
