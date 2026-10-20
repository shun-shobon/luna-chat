# Luna アーキテクチャ設計書

## 1. 設計方針と目標

Lunaは、単一のNode.jsプロセス内でDiscordとHTTPの会話、自律タスクを並行処理する、モジュラーヘキサゴナルアーキテクチャ（クリーンアーキテクチャ）として構築される。

### 主要な原則

1. **外部境界の分離**: Discord、Codex、ファイルシステム、システムクロックをドメインおよびアプリケーション層から完全に分離する。
2. **スコープ単位の直列化と並行性**: 会話スコープ内の状態変更は直列化し、異なるスコープ間は完全に並行動作させる。
3. **外部入力の厳格な検証**: 未検証の外部入力はシステムの境界でZod等を用いて検証し、内部に `unknown` や未検証の型を持ち込まない。
4. **影響範囲の局所化**: 通信プロトコルレベルのエラーと、個別のターンやEffectの失敗による影響範囲を明確に分離する。
5. **フレームワーク非依存**: 内部イベントバスやDIフレームワークは用いず、明示的なポートの呼び出しと依存性注入を行う。

## 2. システムコンテキスト

```text
Discord Gateway ─► discord ─► conversation ──────────┐
ローカルHTTP ────► http ─────► conversation ──────────┤
                           └──► event executor ───────┼─► agent runtime ─► Codex app-server
automation sources ──────────► event executor ────────┤
task service（作業エージェント）──────────────────────┘         │
      ▲  task.create / message / cancel                         ▼
      └───────────────────────────────── effect batch ─► Discord / HTTP応答 / タスク

ブラウザ ─► dashboard ─► 各モジュールの snapshot / 直近ログ（読み取りのみ）

Lunaプロセス内: 上記各モジュール、loopback MCP、observability、runtime
外部リソース: LUNA_HOME / マウントされたファイルシステム / stdout
```

- **Codex app-server**: Lunaの子プロセスとして起動され、全スレッドで単一プロセスを共有する。
- **Discord MCP**: Lunaプロセス内部で `127.0.0.1` にバインドされ、Codexからのツール呼び出しを受け付ける。
- **HTTP API**: Nativeでは `127.0.0.1` にバインドする。Docker Composeではコンテナ内の `0.0.0.0` にバインドし、ホストの `127.0.0.1` にのみポートを公開する。
- **ダッシュボード**: HTTP APIとは別のHonoサーバーとして別ポートで待ち受ける。バインド先はHTTP APIと同じく環境変数で選ぶ。

## 3. ソースコード構成

```text
src/
├── modules/
│   ├── discord/         # Discord Gateway/REST, MCP, 会話委譲
│   │   ├── domain/
│   │   ├── application/
│   │   ├── ports/
│   │   └── adapters/
│   ├── conversation/    # 会話セッション管理, 入力バッチ, アイドルタイマー
│   ├── agent/           # Codexプロセス管理, JSON-RPC通信, スレッド制御
│   ├── event/           # 共通イベントエンベロープ, ワンショット実行
│   ├── http/            # HTTPイベント受付, 応答Effect, 待機中の応答管理
│   ├── effect/          # Effectレジストリ, バッチ実行, 出力検証
│   ├── automation/      # ハートビート, スケジュール, 日次整理
│   ├── task/            # バックグラウンドタスク, 作業エージェントの実行, 依頼元への通知
│   ├── workspace/       # ファイル初期化, 設定読込, cron監視
│   ├── dashboard/       # 状態スナップショットの集約, 閲覧用ページ
│   └── observability/   # 構造化ログ, 秘匿情報マスク, 直近ログの保持
├── runtime/             # コンポジションルート, エントリポイント
├── shared/              # 機能に依存しない汎用関数・型（日付整形、JSON値、Honoサーバーの起動）
└── generated/codex/     # Codex CLIから自動生成された型定義
```

各モジュールは必要なレイヤーのみを保持する。モジュール間をまたぐビジネスロジックは、それを実行する上位のアプリケーション層に配置する。

## 4. モジュールの責務 (Capability Ownership)

| モジュール      | 主な責務・所有する概念                                               | 公開インターフェース（ポート）                                                                       | 主なアダプター                                            |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `discord`       | メッセージ正規化、スコープ判定、Discord Effect、タイピング管理       | イベント変換、Effectプロバイダ、Discord API呼び出し、Gateway購読                                     | discord.js Gateway/REST、loopback MCP                     |
| `conversation`  | セッション状態、入力キュー、アイドル監視、記憶保存、モデル設定       | `accept`、`configure`、`endSession`、`typing`、`stopIntake`、`drain`、`abort`                        | Discordコントローラー、履歴取得                           |
| `agent`         | Codexプロセス、スレッド・ターンの管理、通知の相関付け                | `listModels`、`openThread`、`startTurn`、`steer`、`archive`、`listArchived`、`delete`                | stdio子プロセス、JSON-RPC                                 |
| `event`         | 共通イベント（`LunaEvent`）、ワンショット実行                        | `execute`、`connectionLost`                                                                          | なし（EventExecutorがagentポートを直接呼ぶ）              |
| `http`          | HTTPイベントの検証、受付、完了待ち応答                               | `submit`、`stopIntake`、`drain`                                                                      | Hono、`http.respond` Effect                               |
| `effect`        | Effect定義、スキーマ生成、出力検証、バッチ並行実行                   | スキーマ生成、パース、`execute`、`release`                                                           | 各種Effectプロバイダ                                      |
| `automation`    | ハートビート、スケジュール、日次整理のイベント発火、checkの判定      | `startAutomation`、`stopIntake`、`drain`                                                             | タイマー、cronスケジューラ、ファイル監視、check子プロセス |
| `task`          | タスク状態、作業エージェントの実行枠とターンチェーン、公開範囲、通知 | `create`、`message`、`cancel`、`report`、`listFor`、`start`、`stopIntake`、`drain`、`connectionLost` | JSONファイルストア、`task.*` Effect                       |
| `workspace`     | ディレクトリ初期化、設定ファイル（TOML）の読み書き・監視             | 初期化、プロンプト読み込み、スケジュール読み書き                                                     | ファイルシステム、`smol-toml`、Zod                        |
| `dashboard`     | 各モジュールの状態の集約、閲覧用ページ                               | `snapshot`                                                                                           | Hono（`/`、`/api/snapshot`）                              |
| `observability` | 構造化ログ出力、ログレベル制御、秘匿情報のマスキング、直近ログの保持 | ロガーポート、直近ログの一覧                                                                         | 標準出力（JSON Lines）、メモリ上のリングバッファ          |
| `runtime`       | オブジェクトグラフの構築、起動・終了ライフサイクルの配線             | プロセスエントリポイント                                                                             | シグナルハンドラー                                        |

## 5. 依存関係の方向

- ドメイン層は同一モジュール内のアプリケーション層やアダプター層をインポートしない。
- アプリケーション層はドメイン層とポート（インターフェース）のみに依存する。
- アダプター層はポートを実装し、外部ライブラリやI/Oを扱う。
- モジュール間の連携は、公開されたアプリケーションポートを直接呼び出す。循環参照は避ける。

```text
discord      ──► event
http         ──► conversation / event / effect
conversation ──► event / effect / agent
automation   ──► event
event        ──► agent / effect
task         ──► agent / effect / event（型のみ）
effect       ──► provider
automation   ──► workspace
dashboard    ──► agent / automation / conversation / event / task / observability（型のみ）
all          ──► observability
runtime      ──► 全モジュール (composition root)
```

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
COLLECTING ── dispatch ready ──► OPENING_THREAD ──► STARTING_TURN
     ▲                                                   │ turn/start response
     │                                                   ▼
     │                                               TURN_ACTIVE
     │                                                   │ completion
     │                                                   ▼
     │                                             EFFECTS_ACTIVE
     │                                              │           │
     │                    failure / wait complete   │           │ other success / empty
     │                                              ▼           ▼
     │                                     FOLLOWUP_STARTING   IDLE
     │                                              │           │
     └──────── queued input after chain ────────────┴───────────┘
                                                                │ idle deadline
                                                                ▼
                                                    SESSION_MEMORY_CHAIN
                                                                │ effects/follow-up complete
                                                                ▼
                                                           ARCHIVING ──► ABSENT
```

- 会話スコープごとにアクター（Mailboxパターン）を1つ保持し、状態変更を直列に処理する。
- 外部I/Oの待機中もメッセージを受け付けてキューに積むことができ、ターン実行中のユーザー割り込み（steer）を即座に反映できる。

## 7. イベントとEffectのオーケストレーション

```text
検証済み入力
     │
     ├─ 新規スレッド作成: LUNA.md + MEMORY.md のロード, thread/start
     │
     ├─ turn/start(outputSchema)
     │       ├─ 実行中にCodexがMCPツール呼び出し（即時実行）
     │       └─ 完了通知を待機
     │
     ├─ parseEffectOutputs(全最終テキスト)  # steer後の続行で1ターンに複数出る
     │
     ├─ EffectBatchPort.execute(effects, ownerId)  # 並行実行
     ├─ EffectBatchPort.release(ownerId)            # タイピング状態の解放
     │
     ├─ 失敗や待機なし ────────────────────────────► 完了
     │
     └─ 失敗または system.wait あり ──► turn/start(effect_results) ─┐
                                                                   └─ 成功するまで継続
```

- Codexからの最終出力は構造化スキーマ（Structured Outputs）によって `{ effects: [{ type, input }] }` 形式に制約される。
- 出力スキーマとEffect typeの一意性は起動時には検証せず、本番の全プロバイダ（`src/runtime/effect-providers.ts`）を対象とするテストで保証する。
- `CodexTurnTracker` は1ターン内の `final_answer` を出た順にすべて保持し、`AgentTurnResult.outputTexts` として返す。最後の1件だけを使うと、steerの前に出た最終回答のEffectが失われる。
- ターンの失敗結果は、Codexの `codexErrorInfo` から求めた `retryable` を持つ。会話アクターは再試行待ちの間 `retry_wait` フェーズで新着をキューへ積み、再試行ターンの開始時にsteerへ移す。EventExecutorとTaskServiceは同じ待機時間（`TURN_RETRY_DELAYS_MS`）で再試行する。
- `EffectOutputContract.parse` は各Effectの入力をプロバイダ定義のスキーマで1回だけ検証・正規化し、表示用の対象（target）と型付き入力を閉じ込めた実行関数を持つ `EffectRequest` に変換する。バッチ実行時に入力を再検証しない。
- バッチ内のEffectはすべて並行して実行され、全件完了（settle）した後に結果を集約する。
- 失敗したEffectや `system.wait` の完了結果は、同一スレッドのフォローアップターンへ渡されて自律的なリカバリが行われる。
- `http.respond` は `request_id` をキーにステータスとJSON本文を一時保存する。ワンショット実行または会話のターンチェーンが完了した時点で、待機中のHTTPリクエストを解決する。会話側は初回バッチと成功したsteerのイベントIDを追跡し、チェーン完了時に通知する。

### 7.1 Effectの実行元

`EffectBatchPort.execute` には `ownerId` に加えて実行元（`EffectOrigin`: 会話セッション、イベント、タスク）を渡す。`task.create` や `task.report` は、エージェントの出力ではなくランタイムが保持する実行元で依頼元・報告元を決める。

## 8. Codex app-server アダプター

### 8.1 プロセスのライフサイクル

```text
STOPPED ── spawn/initialize ──► READY
   ▲                              │ 通信エラー / クラッシュ
   │                              ▼
   └──── バックオフ再試行 ◄────── RESTARTING
                                  │ 再起動回数上限超過
                                  ▼
                                FATAL
```

- 子プロセスはホストのPATH上の `codex` を起動する。環境変数から `DISCORD_BOT_TOKEN` を除去し、専用の `CODEX_HOME` を設定する。
- JSON-RPCの通信エラーやタイムアウトが発生した場合、プロセス全体を再起動し、アクティブなターンを失敗させてスレッド参照をリセットする（未処理キューは新スレッドへ引き継ぐ）。接続断の後に作成応答が届いたスレッドは、使わずにアーカイブする。
- 一定時間（`restart_window_ms`）内の再起動回数が上限に達した場合は、安全のためにプロセス全体を終了（FATAL）させる。

### 8.2 スレッドのライフサイクル

- スレッドは永続スレッド（`ephemeral: false`）として作成される。
- 会話のアイドル終了時またはタスク完了時に `thread/archive` を呼び出す。
- 定期クリーンアップタスクにより、保持期間（デフォルト7日）を過ぎたアーカイブ済みスレッドを `thread/delete` で1件ずつ削除する。app-serverは削除を直列に処理するため、並列に要求すると後続がRPCタイムアウトし接続全体の再起動を招く。
- turn単位の通知は、そのスレッドで実行中のturnのトラッカーへ渡す。前のturnで起動した常駐プロセスの出力など、完了済みturn宛ての通知は次のturn中にも届くため、スレッドごとに直近50件の完了済みturn IDを保持して破棄する。未知のturn宛ての通知は取り違えとして接続障害にする。

## 9. Discord アダプター

- **Gateway**: `messageCreate` やタイピングイベントを購読し、正規化されたドメインイベントへ変換する。
- **スラッシュコマンド**: `/luna` コマンドを受け付け、セッション設定やチャンネルの許可リスト更新を処理する。
- **Discord Effect プロバイダ**: メッセージ送信・返信、リアクション、タイピング、会話委譲の各操作を処理する。
- **会話委譲**: バックグラウンドタスク（ハートビート等）がDiscord上で対話を始めたい場合、自身で直接投稿せず、対象スコープの会話セッションへイベントを委譲して処理を委ねる。
- **タイピング管理**: 各ターンやEffectバッチの実行中にタイピング表示を維持し、処理完了時に確実に解放する。
- **MCP サーバー**: Codex向けにチャンネル一覧やメッセージ履歴の読み取りツールを提供する。同じHTTPサーバー上で、全ツールの `/mcp` と読み取りツールだけの `/mcp/read` を別のMCPサーバーインスタンスとして公開する。

HTTPアダプターは `/events` のJSONをZodで検証し、LunaEventを生成する。`one_shot` はEventExecutorへ、`conversation` は `http:<session_id>` の会話セッションへ直接渡す。HTTP会話の初回履歴は空とする。受付停止中は503を返し、受理済みワンショット実行は終了時にdrainする。

## 10. ワークスペースと設定管理

- 初回起動時に `LUNA_HOME` 配下の初期ディレクトリ構造とデフォルト設定ファイルを生成する。
- 設定ファイル（`config.toml`, `cron.toml`）は `smol-toml` と Zod により厳格にパース・検証する。
- `cron.toml` の変更はファイル監視によりリアルタイムに検知され、プロセスの再起動なしでスケジュールが更新される。ワンショットタスクは実行開始直後にファイルから自動削除される。

## 11. オートメーション

ハートビート、スケジュール、日次整理は、それぞれ独立したイベントソースとして動作し、共通のワンショットエグゼキュータを呼び出す。

- **ハートビート**: ランダムな時間間隔で `HEARTBEAT.md` と `AGENDA.md` を読み込み、定期チェックとアジェンダの一手を進める。アジェンダはワークスペースのMarkdownとして持ち、構造の検証はしない（エージェントが読み書きする文書として扱う）。
- **スケジュール**: cron定義または指定日時に基づき、登録されたプロンプトを実行する。各発火を `ActiveExecutionSet` で追跡し、同じジョブの発火同士も直列化しない。
- **check**: `ScheduleController` は `AutomationCheckRunnerPort` だけに依存し、出力の空判定・切り詰め・ログ記録を担う。`ChildProcessCheckRunner` は `/bin/sh -c` を独立したプロセスグループで起動し、タイムアウト時はグループ全体へシグナルを送る。暴走した出力でメモリを使い切らないよう、標準出力は先頭、標準エラー出力は末尾をそれぞれ64000文字まで保持する。checkは発火の実行の一部として追跡されるため、`drain` は実行中のcheckと後続のCodex実行を待つ。
- **日次整理**: 定期cronにより起動し、記憶の統合やファイルの整理を行った後、Gitが利用可能であればローカルコミットを作成する。

## 11.1 バックグラウンドタスク

```text
依頼元(会話/イベント) ──task.create──► TaskService ──queue──► 作業スレッド(thread/start)
        ▲                                 │  turn/start(task) ─► task.report Effect
        │ luna.task.reported.v1           │  turn/steer(task_messages)
        └──── TaskDeliveryPort ◄──────────┘  turn/interrupt(cancel)
```

- `TaskService` はタスクをメモリ上の `Map` で保持し、更新のたびにタスクごとに直列化した書き込みで `TaskStorePort` へ保存する。
- 作業スレッドの開始は実行枠（`max_concurrent`）で制限する。`question` で待機したスレッドはプロセス内の `parked` 表に保持し、Codex接続の再生成で破棄する。
- 作業スレッドのEffectレジストリは `task.report` と `system.wait` だけで構成し、会話・イベント用レジストリとは別の出力スキーマを使う。作業スレッドにはDiscord MCPの `/mcp/read` だけを設定する。
- 通知は `TaskDeliveryPort` を介して、会話には `ConversationCoordinator.accept`、イベント起点にはEventExecutorの新規実行として渡す。配送の受理時刻を報告に記録し、未受理の通知は起動時に再配送する。
- 会話とイベントの入力に同梱するタスク一覧は、`ConversationTaskBoardPort` / `EventTaskBoardPort` を介して `TaskService.listFor` から取得する。conversation・eventモジュールはtaskモジュールに依存しない。
- 取消・シャットダウン・Codex接続断では、作業スレッドの `ownerId` で `EffectBatchPort.release` を呼び、`system.wait` を打ち切る（待機Effectは `ownerId` ごとに未完了の待機を保持し、`release` で失敗させる）。シャットダウンはこれと `turn/interrupt` で作業ループを終わらせ、ループ・配送・保存の完了を待つ。
- 作業ループは終了報告の後にfollow-upを行わない。接続断で中断した場合だけ `running` を `queued` へ戻し、旧接続のスレッドは `parked` へ登録もアーカイブもしない。

## 11.2 状態の可視化（ダッシュボード）

```text
ConversationCoordinator.snapshot ─┐
EventExecutor.snapshot ───────────┤
TaskService.snapshot ─────────────┤
AutomationService.snapshot ───────┼─► DashboardService.snapshot ─► GET /api/snapshot ─► ページ（3秒ごとに取得）
AgentRuntimeSupervisor.status ────┤
RecentLogBuffer.list ─────────────┘
```

- 各モジュールはアプリケーション層に読み取り専用の `snapshot`（Supervisorは `status`）を持ち、状態の型はdomain/ports層に置く。`DashboardSourcePort` はそれらを呼ぶ関数の集まりで、コンポジションルートが配線する。状態の変更通知の仕組みは持たず、取得のたびにメモリ上の状態を読む。
- 会話アクターはフェーズを変えるたびに開始時刻を記録する（`#enter`）。EventExecutorは実行中のイベントとフェーズを保持し、完了・失敗で外す。
- ハートビートは次のタイマーを仕掛けた時点の予定時刻を保持する。日次整理とスケジュールの次回時刻は `ScheduledAutomationJob.nextRunAt`（cronライブラリの `nextDate`）から求める。
- 直近の出来事は、標準出力のロガーと同じ呼び出しを受ける `RecentLogBuffer` が保持する。標準出力と違い `LOG_LEVEL` に関係なくinfo以上を本文付きで残すため、ログレベルを上げずに会話の中身を追える。秘匿フィールドのマスクは標準出力と同じ直列化を使う。
- ページは単一のHTML文字列（`dashboard-page.ts`）で、外部ライブラリを使わない。表示する文字列はすべて `textContent` で入れ、Discordの本文をHTMLとして解釈しない。

## 12. 起動とシャットダウンシーケンス

### 起動 (Startup)

1. 環境変数の検証
2. `LUNA_HOME` および初期ワークスペースファイルの作成・検証
3. `config.toml` と `cron.toml` の読み込み
4. ログ・Discordクライアント・RESTアダプター・MCPサーバーの初期化
5. Codex app-server の起動・初期化
6. Discordへの接続ログイン
7. 保存済みタスクの読み込み、未配送通知の再配送、待機タスクの実行開始（オートメーションのイベントがタスクを作成できるよう先に行う）
8. 過去のアーカイブ済みスレッドのクリーンアップをバックグラウンドで開始（1件数秒かかるため起動を待たせない）
9. Gateway受信、HTTP API、ダッシュボード、ハートビート、日次整理、cron監視の開始

### 終了 (Shutdown)

1. SIGINT / SIGTERM を受信
2. Gatewayからの新規メッセージ、HTTPイベントの受付および新規タイマー発火を停止し、実行中のバックグラウンドタスクを中断してキューへ戻す
3. 受信済みのキュー、実行中のスケジュールのcheck、および実行中のターンチェーンがすべて自然完了するのを待機
4. 正常完了した会話セッションの記憶保存を実行
5. 完了したスレッドをアーカイブ
6. 待機中HTTPリクエストの完了を確認し、HTTPサーバー、ダッシュボード、タイピングリース、ファイル監視、MCP、Discord接続、Codexプロセスを停止
7. ログをフラッシュして終了

## 13. テスト方針

コードカバレッジの数値目標は設定せず、各レイヤーの境界における入出力や状態遷移のテストを重視する。

| テストレイヤー           | 検証対象                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| ドメイン単体テスト       | セッション状態遷移、禁止遷移、イベントエンベロープ、Effectスキーマ                                                  |
| アプリケーション層テスト | バッチ集約・steer順序、記憶保存、フォローアップ、ハートビート、日次整理                                             |
| アダプター層テスト       | Gateway、REST、MCP、JSON-RPC通信、プロセス制御、ファイルシステム、タイマー                                          |
| 異常系マトリクス         | タイムアウト、不正レスポンス、通信切断、例外発生時の挙動                                                            |
| 並行性テスト             | スコープごとの直列化、複数スコープ間の並行実行、シャットダウン時のドレイン処理                                      |
| 結合テスト               | モックを用いた起動からシャットダウンまでの一連の統合フロー                                                          |
| 出力スキーマテスト       | 本番の全Effectプロバイダから生成した出力スキーマがStructured Outputsの受理範囲に収まり、Effect typeが重複しないこと |
| 手動E2Eテスト            | 実Discordおよび実Codexを用いた対話動作の確認                                                                        |

## 14. ビルドとリリースパイプライン

- **ローカルビルド**: `pnpm run build` により、TypeScriptのコンパイルとCommonJSバンドルを行い、Node.jsのSingle Executable Application (SEA) として `dist/luna-chat` を生成する。初期テンプレートファイルはバイナリ内に埋め込まれる。
- **CI品質ゲート**: GitHub Actions上でフォーマット、リント、未使用コード検出（knip）、型チェック（typecheck）、テストを自動実行し、すべてが通過することをmainブランチへのマージ条件とする。
- **リリースワークフロー**: `.github/workflows/release.yml` に手動実行とPRマージ後の処理を集約する。準備ジョブは共通setupでpnpmと依存関係を用意する。`shun-shobon/easy-release` の `prepare` が `.github/easy-release.json` を読み、最新の安定版Gitタグからバージョンを更新し、`updateCommand` の `pnpm format` で整形した変更をPRに含める。マージ後は `draft` が準備PRとバージョンを検証し、タグとドラフトReleaseを作成する。`ready` が `true` の場合だけ、出力された `commit` をDocker・SEAのビルドに、`tag` をイメージタグとアセットの添付先に使う。DockerはLinuxのamd64・arm64、SEAはLinux・macOSのamd64・arm64を対象とし、GitHub Artifact Attestationsを付与する。両ビルドジョブの成功後にDockerの `latest` を更新し、`publish` に `release-id`・`tag`・`commit` を渡して公開する。リリース処理は共通のconcurrencyグループで直列化する。
