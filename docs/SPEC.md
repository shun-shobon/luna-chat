# Luna 仕様書

本書は、Lunaの外部仕様のうち機能をまたぐもの（責務、信頼境界、入力の形式、会話セッション、ワークスペース、設定、記録、エラー時の挙動）を定める。内部設計の全体像は [ARCHITECTURE.md](./ARCHITECTURE.md) にある。機能ごとの仕様と設計は次のファイルに分けている。

| ファイル                                 | 内容                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| [discord.md](./discord.md)               | Discordの受付条件、集約と順序制御、スラッシュコマンド、編集・削除とリアクション |
| [agent.md](./agent.md)                   | モデルの提供元、システムプロンプト、再試行と圧縮、認証と使用枠、再生            |
| [tools.md](./tools.md)                   | ツールの一覧、一時ディレクトリ、バックグラウンド実行、待機                      |
| [http-api.md](./http-api.md)             | HTTPイベントAPIと `http_respond`                                                |
| [automation.md](./automation.md)         | ハートビート、日次整理、スケジュール実行、話題をきっかけにする予定              |
| [tasks.md](./tasks.md)                   | バックグラウンドタスクと作業エージェント                                        |
| [dashboard.md](./dashboard.md)           | 閲覧専用のダッシュボード                                                        |
| [home-assistant.md](./home-assistant.md) | Home Assistantのツール、状態変化をきっかけにした実行、Assist                    |
| [voice.md](./voice.md)                   | ボイスチャンネル                                                                |
| [minecraft.md](./minecraft.md)           | Minecraftのプレイ                                                               |

デスクトップ（ルナ専用の画面）はLunaとは別に配備するもので、[deploy/desktop/README.md](../deploy/desktop/README.md) にある。

## 製品の責務と対象範囲

Lunaは、DiscordとローカルHTTP API、Home Assistantを入力とする単一ユーザー向けの自律ワークスペースエージェントである。1つの配置につき、1つのDiscord Bot、1つのワークスペース、1つのChatGPTの資格情報を持つ。

- Discordの投稿を会話単位に集約し、エージェントのセッションへ渡す。
- HTTPで受けたイベントを独立した実行または会話セッションへ渡す。
- エージェントが呼び出したツール（Discordへの投稿、シェル、ファイル、Web検索、画像生成等）を即時に実行する。
- 定期ハートビートおよびスケジュール設定に基づき、自律的にエージェントを実行する。
- アイドル終了前の会話ログを日次記憶に保存し、定期cronにより記憶とワークスペースを自律的に整理する。
- 長い作業をバックグラウンドタスクとして作業エージェントへ委任し、会話を止めずに結果を依頼元へ届ける。
- 現在の状態と直近の出来事を、閲覧専用のWebダッシュボードで示す。
- Home Assistantの状態の取得と操作、状態変化をきっかけにした実行、Assistの会話エージェントとしての応答を行う。
- Discordのボイスチャンネルで、聞き取った発話に文字または声で返事をする。
- Minecraftのサーバーにプレイヤーとして入り、作業エージェントの計画と決定モデルの判断で遊ぶ（[minecraft.md](./minecraft.md)）。

マルチテナント運用、Windows環境、ダッシュボード以外のWeb UI（操作を伴う画面を含む）、外部公開用CLI、HTTPヘルスチェックエンドポイント、Discord上からの過去セッション再開は対象外とする。

## 信頼境界とセキュリティ

本システムは、Discordの参加者を非特権ユーザーとして隔離しない。Botと対話可能なすべてのユーザー、他のBot、Webhookは、エージェントを介して実行環境の権限を間接的に行使できる。

ローカルHTTP APIも認証を行わず、呼び出し元に同じ権限を与える。Native起動では既定で `127.0.0.1` にバインドし、Docker Composeではホスト側の `127.0.0.1` にのみ公開する。別ホストのHome AssistantからAssistの会話エージェントとして使う場合は `LUNA_HTTP_HOST=0.0.0.0` とし、到達可能なネットワーク内の全員に同じ権限を与える。

ダッシュボードは閲覧専用で認証を行わない。会話本文、ツールの入力、タスクの指示と報告を表示するため、到達できる者はそれらを読める。既定では `127.0.0.1` にバインドし、`LUNA_DASHBOARD_HOST=0.0.0.0` を指定した場合は到達可能なネットワーク内の全員が閲覧できる。

デスクトップを入れた場合、neko のパスワードを知る者は、ルナのログイン済みの Chrome を含むデスクトップを見て操作できる。neko はLANへ待ち受ける。

Minecraft（[minecraft.md](./minecraft.md)）では、設定したサーバーにオフラインモードで接続する。サーバーが送るワールドの内容（ブロック・エンティティ・アイテムの名前と位置、死亡のメッセージ）は観測としてエージェントに渡る。ゲーム内のチャットと看板の文字は渡さない。

エージェントの実行環境には以下の権限が与えられる。

- サンドボックス: なし
- ユーザー承認: なし
- ファイルシステム: 実行ユーザーがアクセス可能な全範囲の読み書き
- コマンド実行: ホストネットワークの利用、パスワードなしsudoを含む特権昇格
- Discord操作: Botがアクセス可能なすべてのチャンネル、スレッド、DMへの読み書き・送信
- Home Assistant操作: 設定したトークンのユーザーが行えるすべての操作

実行前の確認プロンプトや、管理者限定コマンド、コマンドやファイルパスのホワイトリストは設けない。Discordのメンション機能も標準準拠であるため、Botの権限範囲内において `@everyone` や各ロールへの通知が可能である。

## 用語定義

- **会話スコープ**: 単一のGuildチャンネル、Guildスレッド、またはDM。
- **会話セッション**: 会話ごとにメモリ上で保持される状態。メッセージキュー、エージェントのセッション、アイドルタイマーを管理する。Discordの会話スコープのほか、HTTPの `session_id`、Home Assistantの状態変化とAssistにも会話セッションがある。
- **`LunaEvent`**: 入力元に依存しない共通イベントエンベロープ。`id`、`type`、`source`、任意の `subject`、タイムスタンプ `occurredAt`、JSON形式の `data` を保持する。
- **エージェントのセッション**: 1つの会話、1回のイベント実行、または1件のタスクの試行で使う、モデルとの一連のやりとり。システムプロンプト、ツール、モデル、記録を持つ。
- **実行**: エージェントのセッションに入力を渡してから、モデルがツール呼び出しを終えて応答を終えるまでの一連の処理。
- **割り込み入力**: 実行中に届いた入力。実行中のツール呼び出しが終わった後、次のモデルへのリクエストの前に入る。
- **イベント実行**: 会話に属さない入力（ハートビート、スケジュール、日次整理、HTTPの `one_shot` など）を、新しいエージェントのセッションで実行し、終わったら閉じるもの。
- **ツール**: エージェントが実行中に呼び出す操作。呼び出された時点で実行して結果をエージェントへ返す（[tools.md](./tools.md)）。
- **常設チャンネル**: `allowed_channel_ids` に登録されたGuildチャンネル、またはLunaが参加している対象チャンネル配下のスレッド。メンションなしで常時メッセージを受け付ける。
- **一時セッション**: 常設でないチャンネルやスレッドにおいて、メンションまたは会話委譲により開始された30分間のセッション。
- **会話委譲**: イベント実行や別の会話から `open_conversation` を用い、指定したスコープのセッションへ背景情報を渡して対話を委ねる機能。
- **セッション記憶保存**: アイドル終了を迎えた会話のエージェント自身が、要約や決定事項を `memory/YYYY-MM-DD.md` に追記する処理。
- **バックグラウンドタスク**: 会話またはイベント実行（依頼元）が作業エージェントへ委任した作業（[tasks.md](./tasks.md)）。
- **バックグラウンド実行**: `exec_command` の `run_in_background` で起動し、実行の終了を待たずに動き続けるシェルコマンド（[tools.md](./tools.md)）。
- **続いている作業**: 実行が終わっても動き続け、出来事をセッションへ通知するもの。バックグラウンド実行と、Minecraftのプレイ（[minecraft.md](./minecraft.md)）がある。

## 入力の形式

エージェントへの入力は種類（`kind`）付きのメッセージとして渡す。各メッセージはモデルには `<luna_input kind="...">` で包んだuserメッセージとして見え、本文は検証済みのオブジェクトを `JSON.stringify` したものとする。

| `kind`                                                | 本文                                                                       | 渡す場面                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `discord_message`                                     | `discord.message.created.v1` の `LunaEvent`                                | 会話への投稿                                               |
| `discord_message_edited` / `discord_message_deleted`  | `discord.message.edited.v1` / `discord.message.deleted.v1` の `LunaEvent`  | 既知のメッセージの編集・削除（[discord.md](./discord.md)） |
| `discord_reaction_added` / `discord_reaction_removed` | `discord.reaction.added.v1` / `discord.reaction.removed.v1` の `LunaEvent` | 既知のメッセージへのリアクションの追加・削除               |
| `delegated_conversation`                              | `discord.conversation.delegated.v1` の `LunaEvent`                         | 会話委譲                                                   |
| `task_report`                                         | `luna.task.reported.v1` の `LunaEvent`                                     | タスクの報告の通知（[tasks.md](./tasks.md)）               |
| `heartbeat` / `schedule` / `memory_maintenance`       | 各 `system.*.fired.v1` の `LunaEvent`                                      | オートメーション（[automation.md](./automation.md)）       |
| `intent`                                              | `{ id, action, keyword, messageId, firesRemaining }`                       | 話題をきっかけにする予定の発火                             |
| `http_request`                                        | `source: "http"` の `LunaEvent`                                            | HTTPイベント（[http-api.md](./http-api.md)）               |
| `home_assistant_state`                                | `home_assistant.state_changed.v1` の `LunaEvent`                           | Home Assistantの状態変化                                   |
| `assist_request`                                      | `home_assistant.assist.requested.v1` の `LunaEvent`                        | Assistへの発話                                             |
| `voice_utterance`                                     | `discord.voice.utterance.v1` の `LunaEvent`                                | ボイスチャンネルでの発話（[voice.md](./voice.md)）         |
| `voice_delegation`                                    | `discord.voice.delegated.v1` の `LunaEvent`                                | 音声モードの表からの依頼                                   |
| `voice_transcript`                                    | `discord.voice.transcript.v1` の `LunaEvent`                               | 音声モードを終えた時の残りの会話記録                       |
| `event`                                               | 上記以外の `LunaEvent`                                                     | その他のイベント                                           |
| `history`                                             | `LunaEvent[]`                                                              | 会話セッションの最初の実行（初回コンテキストがある場合）   |
| `task_board`                                          | `TaskSummary[]`                                                            | 会話とイベント実行の各実行の開始時                         |
| `session_end`                                         | `{ date: string }`（ローカル日付）                                         | セッション記憶保存                                         |
| `task_assignment` / `task_message` / `task_check`     | [tasks.md](./tasks.md) を参照                                              | 作業エージェント                                           |
| `background_exit`                                     | `BackgroundExit`                                                           | バックグラウンド実行の終了                                 |
| `minecraft_event`                                     | `MinecraftEvent`（[minecraft.md](./minecraft.md)）                         | Minecraftのプレイの出来事                                  |

添付ファイルはURLやメタデータのみを渡し、ランタイム側でのファイル自動ダウンロードは行わない。

## 会話セッションのライフサイクル

セッションのアイドル判定時間は `session_idle_ms`（デフォルト30分）とする。実行が完了し、未処理キューが空になった時点から計測を開始する。実行中（`wait` ツールでの待機を含む）と、バックグラウンド実行が残っている間は計測されない。バックグラウンド実行が終わると `background_exit` を受けて同じセッションで実行し、その完了から計測する。新たなメッセージを受信した場合はタイマーをリセットし、再び処理完了後に計測を行う。

アイドル期限に達した場合、`/luna end` を受けた場合、あるいは安全なシャットダウン時に処理中の実行が完了した場合、セッション記憶保存を実行する（`[memory].enabled = false` なら行わずに閉じる）。その前に、残っているバックグラウンド実行を止める。セッション記憶保存では、同じエージェントのセッションへ `session_end` を渡して実行し、エージェントが会話全体を要約して `memory/YYYY-MM-DD.md`（当日のローカル日付）に追記する。保存処理が完了すると、セッションを閉じる。

最終応答の本文はどこにも送らず、記録にだけ残す。Discordへの発言はすべてツールで行い、返信しないこともエージェントの判断として認める。

## ワークスペース

ワークスペースは `LUNA_HOME/workspace` に配置される。起動のたびに、以下のファイルのうち存在しないものをテンプレート（`templates/`）から生成する（既存ファイルは上書きしない）。

- `LUNA.md`: エージェントの人格および対話方針。
- `MEMORY.md`: 長期記憶の起点ファイル。作業エージェント以外のシステムプロンプトに入る。
- `HEARTBEAT.md`: ハートビート時に確認するチェックリスト。
- `AGENDA.md`: ルナが続けたいこと・引き受けた約束・気になっていることの一覧。
- `cron.toml`: スケジュール実行の設定。週次の見直し `self-review-weekly` を持つ。
- `.agents/skills/cron/`・`.agents/skills/heartbeat/`: スケジュールとハートビートの運用手順のskill。

ワークスペースのディレクトリが存在しない初回起動時だけ、次のファイルも生成する。ルナが整理で移動・改名・アーカイブし得るため、以降の起動では作り直さない。

- `memory/topics/know-how.md`、`users/README.md`
- `.agents/skills/self-review/`: 週次の見直し。直近の会話から `LUNA.md`・`MEMORY.md` の変更案を作り、[再生](./agent.md#再生) で現行と比べてから反映する。
- `.agents/skills/x-status-fetch/`: Xの投稿を取得するskill。

`intents.toml`（[automation.md](./automation.md)）と `home-assistant.toml`（[home-assistant.md](./home-assistant.md)）は任意で、初回には生成しない。同梱のスクリプトはPython 3で実行する。

エージェントは、要らなくなったものを `.trash/<捨てた日のローカル日付 YYYY-MM-DD>/` へ、ワークスペースでの相対パスのまま移して捨てる。起動時と6時間ごとに、日付から14日経った日になった日付フォルダを中身ごと削除する。日付の形でない名前はwarnログ `workspace.trash.unknown_entry` を記録して残す。削除するまでの間はダッシュボードに表示し、必要なら元の場所へ戻せる。

## 設定

### `config.toml`

`LUNA_HOME/config.toml` でシステム全体の動作パラメータを設定する。`[memory]` セクションのみが必須で、他は省略可能である。省略した項目は次の値になる。`[voice]` は [voice.md](./voice.md)、`[minecraft]` は [minecraft.md](./minecraft.md) にある。

```toml
[discord]
allowed_channel_ids = []
allow_dm = true
debounce_ms = 5000
typing_idle_ms = 10000
session_idle_ms = 1800000
initial_history_limit = 20

[heartbeat]
enabled = true
min_interval_ms = 900000
max_interval_ms = 2700000

[memory]
enabled = true
maintenance_cron = "0 4 * * *"

[agent]
request_timeout_ms = 300000
transcript_cleanup_enabled = true
transcript_retention_ms = 604800000
transcript_cleanup_interval_ms = 86400000

[models.conversation]
model = "openai-codex/gpt-6.2-sol"
thinking = "medium"

[models.event]
model = "openai-codex/gpt-6.2-sol"
thinking = "medium"

[models.worker]
default = "standard"

[models.worker.choices.standard]
model = "claude-code/claude-opus-5-5"
thinking = "medium"
description = "Most background work: research, coding, and file or media production."

[models.worker.choices.light]
model = "claude-code/claude-sonnet-5-5"
thinking = "medium"
description = "Simple, well-defined work such as collecting information or routine file edits."

[models.worker.choices.heavy]
model = "claude-code/claude-fable-5-2"
thinking = "high"
description = "Hard work that needs deep reasoning, such as complex implementation, debugging, or design."

[models.compaction]
model = "openai-codex/gpt-6.1-terra"
thinking = "low"

[models.voice]
model = "claude-code/claude-haiku-5-5"
thinking = "off"

[models.minecraft]
model = "claude-code/claude-sonnet-5-5"
thinking = "low"
description = "Playing Minecraft as Luna: set goals for the in-game controller and replan on game events."

[tasks]
max_concurrent = 2
```

- `[models.*]` の `model` は `provider/model` の形（例: `claude-code/claude-opus-5-5`。提供元は [agent.md](./agent.md)）とし、`thinking` は `off`・`minimal`・`low`・`medium`・`high`・`xhigh` のいずれかとする。起動時に、提供元のモデルのカタログにない組み合わせ（モデルが存在しない、またはモデルがその推論強度に対応しない）は不正として起動を中止する。
- `[models.worker]` は作業エージェントの選択肢で、`[models.worker.choices.<名前>]` に `model`・`thinking`・`description`（1〜500文字）を書き、`default` にその中の名前を1つ書く。名前は英小文字か数字で始まり、英小文字・数字・`_`・`-` からなる32文字以内とする。依頼元のエージェントには名前と `description` だけを見せるので、`description` にはどんな作業に向くかを書く。`[models.worker]` を書く場合、`default` と1つ以上の選択肢、選択肢のすべての項目を必須とし、`default` が選択肢にない設定は不正とする。
- `[models.minecraft]` はMinecraft（[minecraft.md](./minecraft.md)）の計画役のモデルで、`[minecraft]` を書いた場合だけ書け、そのとき `model`・`thinking`・`description`（1〜500文字）をすべて必須とする（上の値は例で、既定値ではない）。`[minecraft]` があって `[models.minecraft]` がない設定、`[models.worker]` に `minecraft` という選択肢がある設定は不正とする。
- `[tasks].max_concurrent` は同時に実行するバックグラウンドタスクの上限（1以上の整数）である。
- `*_ms` のうちタイマーとして使う値（`transcript_retention_ms` 以外）は、Node.jsのタイマー上限である `2147483647` 以下でなければならない。

### 環境変数

| 変数名                 | 必須   | デフォルト値 | 説明                                                                                                                    |
| ---------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`    | はい   | なし         | Discord Botトークン。                                                                                                   |
| `LUNA_HOME`            | いいえ | `~/.luna`    | データ保存ディレクトリの絶対パス。                                                                                      |
| `LOG_LEVEL`            | いいえ | `info`       | ログレベル（`trace` / `debug` / `info` / `warn` / `error`）。                                                           |
| `LUNA_HTTP_HOST`       | いいえ | `127.0.0.1`  | HTTP APIの待ち受けアドレス。`127.0.0.1`または`0.0.0.0`。Docker Composeでは後者をコンテナ内で指定。                      |
| `LUNA_HTTP_PORT`       | いいえ | `3000`       | HTTP APIの待ち受けポート（1〜65535）。Docker Composeではホスト側公開ポート。                                            |
| `LUNA_DASHBOARD_HOST`  | いいえ | `127.0.0.1`  | ダッシュボードの待ち受けアドレス。`127.0.0.1`または`0.0.0.0`。                                                          |
| `LUNA_DASHBOARD_PORT`  | いいえ | `3001`       | ダッシュボードの待ち受けポート（1〜65535）。Docker Composeではホスト側公開ポート。                                      |
| `TZ`                   | いいえ | システム依存 | スケジュール等に用いるタイムゾーン。                                                                                    |
| `HOME_ASSISTANT_URL`   | いいえ | なし         | Home AssistantのURL（例 `http://homeassistant.local:8123`）。`http` か `https`。`HOME_ASSISTANT_TOKEN` と組で指定する。 |
| `HOME_ASSISTANT_TOKEN` | いいえ | なし         | Home Assistantの長期アクセストークン。`HOME_ASSISTANT_URL` と組で指定する。                                             |
| `OPENAI_API_KEY`       | いいえ | なし         | OpenAI APIの鍵。`[voice].interrupt_model` か `[minecraft].decision_model` が `openai/*` のとき必須。                    |
| `TYPESAFE_API_KEY`     | いいえ | なし         | TypeSafeのAPIの鍵。`[voice].interrupt_model` か `[minecraft].decision_model` が `typesafe/*` のとき必須。               |

`DISCORD_BOT_TOKEN`・`OPENAI_API_KEY`・`TYPESAFE_API_KEY` は、シェルツールとスケジュールの `check` の子プロセスには渡さない。`HOME_ASSISTANT_TOKEN` は渡す。

## 記録の保持

エージェントのセッションは `LUNA_HOME/sessions/<YYYY-MM-DD>/<セッションID>.jsonl` に記録する。1行目はセッションの種類・ラベル・モデル、2行目はシステムプロンプトとし、以後はメッセージ（入力、モデルの応答、ツールの結果）・モデルの変更・圧縮の内容を1行ずつ追記する。日付は開いた日のローカル日付とする。Lunaを再起動してもセッションは復元しない。

起動時および `transcript_cleanup_interval_ms` ごとに、最終更新から `transcript_retention_ms`（デフォルト7日）を過ぎた記録と、空になった日付のディレクトリを削除する。削除に失敗した記録は次回のクリーンアップで再試行する。`transcript_cleanup_enabled = false` のときは記録を削除せず、無期限に残す。

## エラーハンドリングとシャットダウン

| 事象                         | システムの挙動                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行の失敗                   | ログを記録し、セッションを閉じて会話セッションを終える。未開始のキューは新しいセッションで処理する。                                                                  |
| 実行の一時的な失敗           | [agent.md](./agent.md) のとおり同じセッションで再実行する。上限を超えたら「実行の失敗」と同じ扱い。会話（記憶保存を含む）・イベント実行・作業エージェントに適用する。 |
| ツールの失敗                 | 失敗の内容をツールの結果としてエージェントへ返し、同じ実行の中で立て直させる。                                                                                        |
| 認証の失敗                   | その実行を再試行せずに失敗とし、ダッシュボードに再ログインが必要であることを示す。                                                                                    |
| セッション記憶保存の失敗     | エラーログを記録してセッションを閉じる。リトライは行わない。                                                                                                          |
| 日次整理タスクの失敗         | エラーログを記録してセッションを閉じる。次回cron時刻まで待機。                                                                                                        |
| スケジュールのcheck失敗      | エラーログを記録し、エージェントを起動しない。次回の発火時刻まで待機。                                                                                                |
| バックグラウンドタスクの失敗 | 失敗として記録し、依頼元へ `failure` を通知する。                                                                                                                     |

SIGINTまたはSIGTERMを受信すると、新規メッセージとHTTPイベントの受付および定期タスクの開始を停止し、受信済みのキューや実行中の処理がすべて自然完了するのを待機してから安全に終了する。実行中のスケジュールのcheckも完了を待ち、エージェントを起動する結果であればその実行の完了まで待つ。正常終了した会話セッションは、終了前に記憶保存を実行する。バックグラウンドタスクは中断してキューへ戻す。バックグラウンド実行は終了を待たずに止め、`background_exit` は渡さない。ボイスチャンネルには受付の停止と同時に出る。

## ログと監視

ログはすべて標準出力にJSON Lines形式で出力される。`LOG_LEVEL=debug` または `trace` ではメッセージ本文やプロンプト、ツール引数が出力される。Botトークン等の既知の機密情報はマスクされるが、自由文に含まれる認証情報等の完全な除去は保証されない。外部監視は、プロセスの死活監視および終了コードによって行う。
