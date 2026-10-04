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
automation sources ──────────► event executor ────────┘         │
                                                               ▼
                                             effect batch ─► Discord / HTTP応答

Lunaプロセス内: 上記各モジュール、loopback MCP、observability、runtime
外部リソース: LUNA_HOME / マウントされたファイルシステム / stdout
```

- **Codex app-server**: Lunaの子プロセスとして起動され、全スレッドで単一プロセスを共有する。
- **Discord MCP**: Lunaプロセス内部で `127.0.0.1` にバインドされ、Codexからのツール呼び出しを受け付ける。
- **HTTP API**: Nativeでは `127.0.0.1` にバインドする。Docker Composeではコンテナ内の `0.0.0.0` にバインドし、ホストの `127.0.0.1` にのみポートを公開する。

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
│   ├── workspace/       # ファイル初期化, 設定読込, cron監視
│   └── observability/   # 構造化ログ, 秘匿情報マスク
├── runtime/             # コンポジションルート, エントリポイント
└── generated/codex/     # Codex CLIから自動生成された型定義
```

各モジュールは必要なレイヤーのみを保持する。モジュール間をまたぐビジネスロジックは、それを実行する上位のアプリケーション層に配置する。

## 4. モジュールの責務 (Capability Ownership)

| モジュール      | 主な責務・所有する概念                                         | 公開インターフェース（ポート）                                                | 主なアダプター                           |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `discord`       | メッセージ正規化、スコープ判定、Discord Effect、タイピング管理 | イベント変換、Effectプロバイダ、Discord API呼び出し、Gateway購読              | discord.js Gateway/REST、loopback MCP    |
| `conversation`  | セッション状態、入力キュー、アイドル監視、記憶保存、モデル設定 | `accept`、`configure`、`endSession`、`typing`、`stopIntake`、`drain`、`abort` | Discordコントローラー、履歴取得          |
| `agent`         | Codexプロセス、スレッド・ターンの管理、通知の相関付け          | `listModels`、`openThread`、`startTurn`、`steer`、`archive`、`deleteArchived` | stdio子プロセス、JSON-RPC                |
| `event`         | 共通イベント（`LunaEvent`）、ワンショット実行                  | `execute`                                                                     | プロバイダ非依存のAgentアダプター        |
| `http`          | HTTPイベントの検証、受付、完了待ち応答                         | `submit`、`stopIntake`、`drain`                                               | Hono、`http.respond` Effect              |
| `effect`        | Effect定義、スキーマ生成、出力検証、バッチ並行実行             | スキーマ生成、パース、`execute`、`release`                                    | 各種Effectプロバイダ                     |
| `automation`    | ハートビート、スケジュール、日次整理のイベント発火             | `startAutomation`、`reloadSchedule`、`stopIntake`、`drain`                    | タイマー、cronスケジューラ、ファイル監視 |
| `workspace`     | ディレクトリ初期化、設定ファイル（TOML）の読み書き・監視       | 初期化、プロンプト読み込み、スケジュール読み書き                              | ファイルシステム、`smol-toml`、Zod       |
| `observability` | 構造化ログ出力、ログレベル制御、秘匿情報のマスキング           | ロガーポート                                                                  | 標準出力（JSON Lines）                   |
| `runtime`       | オブジェクトグラフの構築、起動・終了ライフサイクルの配線       | プロセスエントリポイント                                                      | シグナルハンドラー                       |

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
effect       ──► provider
automation   ──► workspace
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
     ├─ 新規スレッド作成: LUNA.md + MEMORY.md + 前日/当日の日次ログのロード, thread/start
     │
     ├─ turn/start(outputSchema)
     │       ├─ 実行中にCodexがMCPツール呼び出し（即時実行）
     │       └─ 完了通知を待機
     │
     ├─ EffectOutputContract.parse(最終テキスト)
     │
     ├─ EffectBatchPort.execute(effects, ownerId)  # 並行実行
     ├─ EffectBatchPort.release(ownerId)            # タイピング状態の解放
     │
     ├─ 失敗や待機なし ────────────────────────────► 完了
     │
     └─ 失敗または system.wait あり ──► turn/start(effect_results) ─┐
                                                                   └─ 成功するまで継続
```

- Codexからの最終出力は構造化スキーマ（Structured Outputs）によって `{ effects: EffectRequest[] }` 形式に制約される。
- バッチ内のEffectはすべて並行して実行され、全件完了（settle）した後に結果を集約する。
- 失敗したEffectや `system.wait` の完了結果は、同一スレッドのフォローアップターンへ渡されて自律的なリカバリが行われる。
- `http.respond` は `request_id` をキーにステータスとJSON本文を一時保存する。ワンショット実行または会話のターンチェーンが完了した時点で、待機中のHTTPリクエストを解決する。会話側は初回バッチと成功したsteerのイベントIDを追跡し、チェーン完了時に通知する。

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
- JSON-RPCの通信エラーやタイムアウトが発生した場合、プロセス全体を再起動し、アクティブなターンを失敗させてスレッド参照をリセットする（未処理キューは新スレッドへ引き継ぐ）。
- 一定時間（`restart_window_ms`）内の再起動回数が上限に達した場合は、安全のためにプロセス全体を終了（FATAL）させる。

### 8.2 スレッドのライフサイクル

- スレッドは永続スレッド（`ephemeral: false`）として作成される。
- 会話のアイドル終了時またはタスク完了時に `thread/archive` を呼び出す。
- 定期クリーンアップタスクにより、保持期間（デフォルト7日）を過ぎたアーカイブ済みスレッドを `thread/delete` で削除する。

## 9. Discord アダプター

- **Gateway**: `messageCreate` やタイピングイベントを購読し、正規化されたドメインイベントへ変換する。
- **スラッシュコマンド**: `/luna` コマンドを受け付け、セッション設定やチャンネルの許可リスト更新を処理する。
- **Discord Effect プロバイダ**: メッセージ送信・返信、リアクション、タイピング、会話委譲の各操作を処理する。
- **会話委譲**: バックグラウンドタスク（ハートビート等）がDiscord上で対話を始めたい場合、自身で直接投稿せず、対象スコープの会話セッションへイベントを委譲して処理を委ねる。
- **タイピング管理**: 各ターンやEffectバッチの実行中にタイピング表示を維持し、処理完了時に確実に解放する。
- **MCP サーバー**: Codex向けにチャンネル一覧やメッセージ履歴の読み取りツールを提供する。

HTTPアダプターは `/events` のJSONをZodで検証し、LunaEventを生成する。`one_shot` はEventExecutorへ、`conversation` は `http:<session_id>` の会話セッションへ直接渡す。HTTP会話の初回履歴は空とする。受付停止中は503を返し、受理済みワンショット実行は終了時にdrainする。

## 10. ワークスペースと設定管理

- 初回起動時に `LUNA_HOME` 配下の初期ディレクトリ構造とデフォルト設定ファイルを生成する。
- 設定ファイル（`config.toml`, `cron.toml`）は `smol-toml` と Zod により厳格にパース・検証する。
- `cron.toml` の変更はファイル監視によりリアルタイムに検知され、プロセスの再起動なしでスケジュールが更新される。ワンショットタスクは実行開始直後にファイルから自動削除される。

## 11. オートメーション

ハートビート、スケジュール、日次整理は、それぞれ独立したイベントソースとして動作し、共通のワンショットエグゼキュータを呼び出す。

- **ハートビート**: ランダムな時間間隔で `HEARTBEAT.md` を読み込み、定期チェックを行う。
- **スケジュール**: cron定義または指定日時に基づき、登録されたプロンプトを実行する。
- **日次整理**: 定期cronにより起動し、記憶の統合やファイルの整理を行った後、Gitが利用可能であればローカルコミットを作成する。

## 12. 起動とシャットダウンシーケンス

### 起動 (Startup)

1. 環境変数の検証
2. `LUNA_HOME` および初期ワークスペースファイルの作成・検証
3. `config.toml` と `cron.toml` の読み込み
4. ログ・Discordクライアント・RESTアダプター・MCPサーバーの初期化
5. Codex app-server の起動・初期化
6. Discordへの接続ログイン
7. 過去のアーカイブ済みスレッドのクリーンアップ
8. Gateway受信、HTTP API、ハートビート、日次整理、cron監視の開始

### 終了 (Shutdown)

1. SIGINT / SIGTERM を受信
2. Gatewayからの新規メッセージ、HTTPイベントの受付および新規タイマー発火を停止
3. 受信済みのキューおよび実行中のターンチェーンがすべて自然完了するのを待機
4. 正常完了した会話セッションの記憶保存を実行
5. 完了したスレッドをアーカイブ
6. 待機中HTTPリクエストの完了を確認し、HTTPサーバー、タイピングリース、ファイル監視、MCP、Discord接続、Codexプロセスを停止
7. ログをフラッシュして終了

## 13. テスト方針

コードカバレッジの数値目標は設定せず、各レイヤーの境界における入出力や状態遷移のテストを重視する。

| テストレイヤー           | 検証対象                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| ドメイン単体テスト       | セッション状態遷移、禁止遷移、イベントエンベロープ、Effectスキーマ             |
| アプリケーション層テスト | バッチ集約・steer順序、記憶保存、フォローアップ、ハートビート、日次整理        |
| アダプター層テスト       | Gateway、REST、MCP、JSON-RPC通信、プロセス制御、ファイルシステム、タイマー     |
| 異常系マトリクス         | タイムアウト、不正レスポンス、通信切断、例外発生時の挙動                       |
| 並行性テスト             | スコープごとの直列化、複数スコープ間の並行実行、シャットダウン時のドレイン処理 |
| 結合テスト               | モックを用いた起動からシャットダウンまでの一連の統合フロー                     |
| 手動E2Eテスト            | 実Discordおよび実Codexを用いた対話動作の確認                                   |

## 14. ビルドとリリースパイプライン

- **ローカルビルド**: `pnpm run build` により、TypeScriptのコンパイルとCommonJSバンドルを行い、Node.jsのSingle Executable Application (SEA) として `dist/luna-chat` を生成する。初期テンプレートファイルはバイナリ内に埋め込まれる。
- **CI品質ゲート**: GitHub Actions上でフォーマット、リント、未使用コード検出（knip）、型チェック（typecheck）、テストを自動実行し、すべてが通過することをmainブランチへのマージ条件とする。
- **リリースワークフロー**: `.github/workflows/release.yml` に手動実行とPRマージ後の処理を集約する。準備ジョブは共通setupでpnpmと依存関係を用意する。`shun-shobon/easy-release` の `prepare` が `.github/easy-release.json` を読み、最新の安定版Gitタグからバージョンを更新し、`updateCommand` の `pnpm format` で整形した変更をPRに含める。マージ後は `draft` が準備PRとバージョンを検証し、タグとドラフトReleaseを作成する。`ready` が `true` の場合だけ、出力された `commit` をDocker・SEAのビルドに、`tag` をイメージタグとアセットの添付先に使う。DockerはLinuxのamd64・arm64、SEAはLinux・macOSのamd64・arm64を対象とし、GitHub Artifact Attestationsを付与する。両ビルドジョブの成功後にDockerの `latest` を更新し、`publish` に `release-id`・`tag`・`commit` を渡して公開する。リリース処理は共通のconcurrencyグループで直列化する。
