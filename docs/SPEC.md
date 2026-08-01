# Luna 仕様

## 1. 文書の位置づけ

この文書は、再設計後のLunaについて、利用者と外部systemから観測できる振る舞いを定める正本である。内部のmodule構成と実現方法は [ARCHITECTURE.md](./ARCHITECTURE.md) に定める。

この仕様は旧実装との互換性、自動migration、旧設定の読替えを要求しない。旧形式を受理するalias、silent fallback、互換layerは設けない。

## 2. 製品責務

Lunaは、Discordを入口とする一人用workspace agentである。一つの配置につき、一つのDiscord Bot、一つのLuna workspace、一つの専用Codex homeを持つ。

Lunaは次を行う。

- Discord投稿を会話単位に集約し、Codex app-serverへ渡す。
- Codexが明示した型付きDiscordアクションを実行する。
- heartbeatと利用者定義のscheduleから自律的にCodex turnを開始する。
- `LUNA.md` と `MEMORY.md` を新しいCodex threadの人格・長期記憶として使う。
- idle終了前の会話を日次記憶へ保存し、設定cronで記憶とworkspaceを整理する。

multi-tenant service、Windows、公開CLI、Web UI、HTTP health endpoint、Discordからの過去thread再開は対象外とする。

## 3. 信頼境界

この配置は、Discord参加者を非特権入力元として隔離しない。Botへ入力を配送できるLuna自身以外の人間、Bot、Webhookは、Codexを介して配置先の実行権限を間接的に行使できる。

Codexには次を明示する。

- sandboxはdanger-full-access相当。
- approval policyは`never`。
- filesystemはOS実行ユーザーがアクセスできる全範囲。
- command、host network、passwordless sudoを含む権限昇格を許可。
- DiscordはBotが到達できる全channel、thread、DMを操作可能。

追加確認、所有者だけの特権操作、command allowlist、filesystem allowlistは設けない。Discord本文は標準のmention解析を使うため、Bot権限があればuser、role、`@everyone`等へ通知できる。

## 4. 用語

- 会話scope: Guild channel、Guild thread、DMのいずれか一つ。
- 会話session: scopeごとのqueue、active turn、Codex thread ID、idle状態を持つmemory上の状態。
- turn chain: 最初のCodex turnと、Discordアクション失敗から生じる同一thread上のfollow-up turn列。
- Discordアクション: Zodで検証後にDiscord APIへ反映する型付き命令。
- 常設channel: `allowed_channel_ids` に含まれるGuild channel、その配下のthread、またはIDを直接含めたthread。mentionなしで常時受信する。
- 一時session: 常設でないscopeにおいて、Lunaへのmentionで開始されたsession。
- session記憶保存: idle終了する会話thread自身が、会話要約と将来役立つ事項を`memory/YYYY-MM-DD.md`へ追記するturn。
- 日次整理: 組み込みscheduleが専用threadを作り、記憶とworkspaceを整理してlocal Gitへの保存を試みる実行。

## 5. Discord入力

### 5.1 受付条件

Luna自身の投稿だけを除外し、次を受理する。

- 常設channel内の全`messageCreate`。
- 常設でないGuild channelまたはthreadでLunaをmentionした`messageCreate`。
- 一時session存続中に同じscopeへ届いた全`messageCreate`。
- `allow_dm = true`のときに届いた全DM。

人間、他Bot、Webhook、Discord system messageを区別して入力に含める。他Botとの相互応答loopを防止しない。message editとreaction eventはturnを開始しない。親channelの一時sessionを子threadへ継承せず、thread自身でmentionを必要とする。

`allowed_channel_ids`にGuild channel IDがあれば、その配下のthreadも常設として扱う。常設でない親channelの一時sessionだけは子threadへ継承しない。

`allowed_channel_ids`は空配列を許す。DMは全Discord利用者を対象とし、送信者allowlistを設けない。

### 5.2 scope

Guild channel、Guild thread、DMを必要ID付きの判別可能unionで表す。各scopeは独立した会話sessionを持つ。同じscopeの参加者は一つのCodex会話状態を共有する。

### 5.3 集約と順序

- 最後に受理した投稿から`debounce_ms`だけ待つ。
- 会話内の人間がtyping中なら、そのtypingが`typing_idle_ms`途切れるまで待つ。
- 待機中に受理した投稿をDiscord timestamp順に一つの入力batchへまとめる。同一timestampはmessage ID順とする。
- active Codex turn中の投稿はbatch化せず、受信順に一件ずつ即時`turn/steer`する。
- steer requestが失敗した投稿だけを次のturn用queueへ移す。現在turnが後で失敗してsessionを終了しても、この未開始queueは破棄せず、新しいthreadの最初のturnで処理する。

同じ`messageCreate`が複数回配送された場合、event同士は重複排除せず配送回数だけ処理する。新規sessionの初回履歴と起点eventの間だけmessage IDで重複を除く。

### 5.4 初回履歴

新規sessionは、最初の入力batchより前の直近`initial_history_limit`件を一度だけ取得し、古い順に渡す。Luna自身を含む全投稿種別を履歴に含める。取得失敗時は現在のbatchだけで続行する。以後の履歴はCodex threadが保持し、Discord APIから再取得しない。

Gateway切断中に取りこぼした投稿を再接続後に補完しない。

### 5.5 入力JSON

Codexへ渡すuser inputは、検証済みobjectを`JSON.stringify`したJSONとする。XMLや文字列templateへ埋め込まない。入力は少なくとも次を持つ。

```ts
type AgentInput =
  | {
      source: "discord";
      scope: ConversationScope;
      history: DiscordMessage[];
      messages: DiscordMessage[];
    }
  | { source: "heartbeat"; checklist: string }
  | { source: "schedule"; jobId: string; prompt: string }
  | { source: "session_memory"; date: string }
  | { source: "memory_maintenance"; date: string };
```

Discord messageはID、timestamp、投稿種別、Guild/channel/authorのIDと表示名、本文、添付metadata、sticker、reaction集計、mention対象、返信参照を型付きfieldとして持つ。DM返信参照は`channelId`と`messageId`、Guild返信参照はそれらに`guildId`を加えたunionとする。

入力添付は名前、URL、byte size、MIME type等だけを含め、runtimeは内容をdownloadしない。

## 6. 会話session

idle期限は全scopeで共通の`session_idle_ms`とする。受理投稿の到着時と、turn chain全体の完了時に現在時刻から再設定する。

idle期限がactive chain中に来た場合は処理を中断せず、close予約を付ける。後続のDiscord投稿が来ればclose予約を取り消す。予約が残ったままchainが完了した場合、idle状態で期限が来た場合、またはgraceful shutdownでsignal前に受理したqueueとactive chainが正常完了した場合にsession記憶保存を実行する。

session記憶保存が有効なら、保存開始日のprocess local dateを`YYYY-MM-DD`として同じCodex threadへ追加turnを送る。agentはthread全体から短い会話要約、嗜好、決定、未完了事項等を選び、既存内容を失わないsession単位のsectionとして`memory/YYYY-MM-DD.md`へ追記する。見出しと詳細構造はagentが決める。保存対象がなければfileを変更しない。`memory/`がなければagentが作る。

保存turnとそのDiscord action failure follow-upは通常turnと同じ規則で実行する。保存中の新着投稿はsteerせずqueueへ残し、保存後に旧threadをarchiveしてから新threadへ渡す。保存turnの開始または完了が失敗した場合は再試行せず、error log後に旧threadをarchiveする。保存turnの完了期限を設けない。

複数scopeのsession記憶保存は並行実行し、同じ日次記憶fileへの排他を設けない。通常turn失敗、connection loss、fatal abortではsession記憶保存を実行しない。

session、queue、close予約、次のheartbeat時刻はmemoryだけに置き、process再起動後に復元しない。

## 7. Workspace

workspaceは`LUNA_HOME/workspace`に置く。初回起動時に不足する次のfileだけを生成し、既存fileを上書きしない。

- `LUNA.md`: 現行の人格・会話方針を一つへ整理した初期内容。Luna自身が編集可能。
- `MEMORY.md`: `# MEMORY.md`だけを持つ初期長期記憶。Luna自身が編集可能。
- `HEARTBEAT.md`: `# HEARTBEAT.md`だけを持つ初期checklist。

`memory/`と日次記憶fileはstartup initializerで生成せず、session記憶保存または日次整理を行うagentが必要時に作る。日次記憶fileは日次整理後も同じpathに残す。

新しいDiscord、heartbeat、schedule、日次整理threadを作るたびに`LUNA.md`と`MEMORY.md`の全文をbase instructionsへ加える。size上限と同時更新lockは設けず、最後のfilesystem writeを採用する。active threadへ途中変更を反映しない。通常threadからの`MEMORY.md`更新を禁止しない。

起動後に`LUNA.md`または`MEMORY.md`を読めない場合は、読めたfileだけで処理を続ける。heartbeat直前に`HEARTBEAT.md`を読めない場合はその実行だけを失敗とし、turnを開始しない。

人格、記憶、応答言語はworkspace instructionsが担う。入出力protocolと権限規則はコード固定のdeveloper instructionsが担う。

## 8. Codex実行

一つの固定版`@openai/codex` app-server processを全会話、heartbeat、schedule、日次整理で共有する。PATH上の別Codexへfallbackしない。

model、reasoning effort、Codex組込みtoolはrequestで指定せず、専用`CODEX_HOME`のCodex defaultを使う。Discord MCPだけを追加する。全threadは`ephemeral: false`とする。

Codexの`request_user_input`機能は有効化せず、中継しない。予期せぬ利用者入力requestはprotocol errorとして該当turnを失敗させ、そのthreadをarchiveしてsessionを終了する。

全JSON-RPC requestに共通の`rpc_timeout_ms`を適用する。どのrequestでもtimeoutした時点でconnection全体を破損扱いにし、全active turnを失敗させ、全thread参照を破棄してapp-serverを再起動する。turn完了notificationを待つ時間には上限を設けない。

turn固有notificationにはthread IDとturn IDを必須とする。Lunaが開始してarchive処理を終えるまでの管理中threadだけをactive turnへ相関する。同じapp-server接続へ届くsubagent等の管理外thread通知はLunaのturn状態へ反映しない。管理中threadでactive turnへ相関できない通知、IDが欠落した通知、stdoutの不正JSON、未知response形式はprocess異常とし、全active turnを失敗させる。

## 9. Discord MCP

Discord MCPは`127.0.0.1`だけへbindし、HTTP認証を持たない。想定clientはCodex app-serverだが、同じnetwork namespaceのlocal processも接続できる。次のread toolを提供する。

- `read_message_history`: 明示したchannel/thread/DMの履歴を読む。
- `list_channels`: Botが到達できるchannelとthreadを列挙する。
- `get_user_detail`: userと、指定時はGuild member情報を読む。
- `list_guild_emojis`: Guild emojiを列挙する。
- `get_guild_emoji`: Guild emojiの詳細を読む。

また、第10節の各Discordアクションをturn途中に呼べる型付きwrite toolとして提供する。MCPで実行済みの操作とfinal actionを重複判定せず、明示された全操作を累積実行する。

## 10. 最終出力とDiscordアクション

### 10.1 出力envelope

`turn/start.outputSchema`で最終assistant messageを次へ制約し、runtimeでもJSON parseとZod検証を行う。

```ts
type AgentOutput = { actions: DiscordAction[] };
```

空の`actions`はmentionまたはDMへの応答でも正常である。parseまたは検証に失敗した場合は一件も実行せず、turnを失敗とする。

### 10.2 初期アクション

初期版は次の判別可能unionだけを実装する。

- `send_message`: channel/thread IDまたはDM user IDへ本文とfileを送る。
- `reply_message`: channel IDとmessage IDを明示して返信する。
- `add_reaction`: messageへUnicodeまたはcustom emoji reactionを付ける。
- `remove_reaction`: Luna自身のreactionを外す。
- `start_typing`: 対象でtyping更新を開始する。
- `stop_typing`: 対象のtyping更新を止める。

外部schemaは次を基準とする。全IDは空でないDiscord snowflake文字列である。

```ts
type DiscordTarget = { kind: "channel"; channelId: string } | { kind: "dm_user"; userId: string };

type MessageLocation = { channelId: string; messageId: string };

type SendFile = {
  path: string; // absolute path
  fileName?: string;
  description?: string;
};

type DiscordEmoji =
  | { kind: "unicode"; value: string }
  | { kind: "custom"; id: string; name?: string };

type DiscordAction =
  | { kind: "send_message"; target: DiscordTarget; content?: string; files?: SendFile[] }
  | ({ kind: "reply_message"; content?: string; files?: SendFile[] } & MessageLocation)
  | ({ kind: "add_reaction"; emoji: DiscordEmoji } & MessageLocation)
  | ({ kind: "remove_reaction"; emoji: DiscordEmoji } & MessageLocation)
  | { kind: "start_typing"; target: DiscordTarget }
  | { kind: "stop_typing"; target: DiscordTarget };
```

`reply_message`、reactionの`channelId`にはGuild channel、thread、DM channelのいずれも指定できる。DM user IDは新しいDMを開く`send_message`とtyping targetだけで使い、既存messageの位置指定には使わない。

message edit/delete、thread作成、role操作、embed、component、pollは初期版の対象外とする。generic Discord REST actionは提供しない。

送信と返信はplain textとfile attachmentだけを扱い、少なくとも一方を必須とする。fileは絶対path、任意の表示file名、任意の説明を持つ。realpath解決後に通常fileかつ読取可能であることを検証する。URLの取得・再添付はしない。

Discord文字数上限は送信前に検証する。超過を自動分割しない。返信先が参照不能でも通常投稿へ変換しない。いずれもaction failureとしてfollow-upへ渡す。

### 10.3 実行とfollow-up

final actionは全件を同時開始し、全件settleを待つ。一件の失敗で他actionをcancelしない。結果は元の配列indexと対応づける。相互に依存するactionの順序は保証しない。

一件以上失敗した場合だけ、成功・失敗の全結果を同じCodex threadの新しいfollow-up turnへ渡す。follow-upのfinal actionにも同じ規則を適用する。全action成功または空actionまで続け、回数、時間、同一error反復の上限を設けない。失敗をDiscordへ暗黙通知しない。

final actionのsettle待機中にapp-server connectionを失った場合も、開始済みDiscord actionはcancelしない。ただし同一threadが失われるため、失敗resultのfollow-upは行わずlogだけに記録し、sessionを終了する。未開始queueはapp-server再起動後に新threadで処理する。

Lunaが開始したtypingは、明示stopに加え、各turnのfinal actionが全件settleした時点で、そのturnが所有する残存typingをruntimeがbest effortでcleanupする。cleanup後に必要ならfollow-up turnを開始する。RPC timeout、session終了、process shutdownでも残存typingをcleanupする。

## 11. Heartbeat

heartbeatは既定で有効とする。一つ前のheartbeatが成功または失敗して完了した後、`[heartbeat].min_interval_ms`以上`[heartbeat].max_interval_ms`以下から一様ランダムに次の間隔を選ぶ。同じheartbeatを並行実行しない。

各実行は`HEARTBEAT.md`を直前に読み、新しいCodex threadを作る。完了後はarchiveする。停止中の予定を補わない。失敗はJSON logだけに記録し、Discordへsystem messageを送らない。

## 12. 記憶とworkspaceの日次整理

`[memory].enabled = true`のとき、`maintenance_cron`を組み込みscheduleとして登録する。cronは分・時・日・月・曜日の5 fieldでprocess local timezoneを使う。設定はstartup時だけ読み、稼働中に再読込しない。停止中のtickを補わず、先行実行が次のtickまで終わらない場合も重複実行を抑止しない。

tickごとに新しい専用Codex threadを作り、実行日のprocess local dateを渡す。agentは全`memory/YYYY-MM-DD.md`、現在の`MEMORY.md`、workspace全体を読み、長期記憶の整理、不要fileの削除、文書の移動・renameを判断する。通常threadと同じfilesystem、command、network、sudo、Discord権限を持ち、application側の保護path、排他、操作検証は設けない。全日次記憶fileは既存pathに残すよう指示する。

通常会話、session記憶保存、heartbeat、利用者schedule、日次整理は互いに並行できる。日次整理中のworkspace変更を止めず、同時更新時は最後のfilesystem writeを採用する。

file整理後、agentはGit executableが利用できる場合だけlocal Gitへ保存する。repositoryがなければ初期化し、local identityを`Luna <luna@localhost>`に設定する。整理前checkpoint、空commit、pushは行わず、整理後に最大一件のcommitを作る。commit message、stage対象、除外対象はagentが判断する。Git executableがなければGit操作だけを省略し、file整理を正常に続行する。applicationはcommit作成とworking tree状態を検証しない。

日次整理turnの完了期限を設けない。成功または失敗後にthreadをarchiveする。成功・失敗の報告だけを目的とするDiscord通知は行わない。失敗はJSON logだけに記録し、即時retryを行わず、次のcron tickを待つ。

## 13. Schedule

`LUNA_HOME/workspace/cron.toml`をstrictに監視し、再起動なしでlast-valid job集合を更新する。jobは利用者指定の一意な安定ID、必須`enabled`、promptを持つ。

fileがなければ、jobが0件の正規化済み`cron.toml`を生成する。生成または初回検証に失敗した場合はstartupを失敗させる。

```toml
[[jobs]]
id = "daily-summary"
enabled = true
kind = "recurring"
cron = "0 21 * * *"
prompt = "今日の会話を確認して、必要ならDiscordへ要約を送る"

[[jobs]]
id = "one-time-reminder"
enabled = true
kind = "one_shot"
at = "2026-08-01T09:00:00+09:00"
prompt = "指定されたリマインドを実行する"
```

cronは分・時・日・月・曜日の5 fieldでprocess local timezoneを使う。one-shotはoffset付きISO 8601文字列を必須とする。`enabled = false`は登録も実行もしない。

同一recurring jobのtickも独立threadで並行実行できる。停止中tickを補わない。過去のone-shotは実行もerror logもせずfileから削除する。

予定時刻のone-shotは`turn/start` response直後に最新fileを再読込し、同じIDを削除して、`smol-toml`で全体を正規化し対象pathへ直接同期writeする。コメント、順序、format、開始後の同一ID変更を保持しない。temporary fileとatomic renameは使わない。削除失敗はlogだけに残すが、同じprocessではjobを再度実行しない。reloadまたは再起動後は過去one-shotとして実行せず、削除だけを再試行する。

startup時の不正`cron.toml`は起動失敗とする。稼働中の不正変更は適用せず、last-valid jobを動かし続ける。

## 14. 設定

### 14.1 `config.toml`

`LUNA_HOME/config.toml`は起動時に一度だけ読む。`[memory]` sectionとその2 fieldは必須とし、他sectionとfieldは省略できる。未知sectionと未知keyは拒否する。既存configに`[memory]`がなければstartupを失敗させ、自動migrationしない。fileがなければ次の完全設定を生成する。数値期間はすべてmillisecond整数である。

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
rpc_timeout_ms = 30000
thread_retention_ms = 2592000000
thread_cleanup_interval_ms = 86400000
restart_initial_delay_ms = 1000
restart_max_delay_ms = 30000
restart_window_ms = 300000
restart_failure_limit = 5
```

`memory.enabled`はsession記憶保存と日次整理を一括で切り替える。`maintenance_cron`は有効・無効にかかわらず正しい5-field cronを必須とする。`min_interval_ms <= max_interval_ms`と`restart_initial_delay_ms <= restart_max_delay_ms`を必須とする。同値のheartbeat間隔は固定間隔である。`initial_history_limit`とrestart delayは0以上、それ以外のtimeoutと期間、`restart_failure_limit`は1以上のsafe integerとする。

### 14.2 環境変数

| 変数                | 必須   | 既定値      | 契約                                                          |
| ------------------- | ------ | ----------- | ------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | はい   | なし        | 空白だけを拒否する。Codex子processへ渡さない。                |
| `LUNA_HOME`         | いいえ | `~/.luna`   | 絶対pathだけを受理する。                                      |
| `LOG_LEVEL`         | いいえ | `info`      | `trace`、`debug`、`info`、`warn`、`error`。不正値は起動失敗。 |
| `TZ`                | いいえ | process依存 | Node.js local timezoneを変更する。Docker既定はAsia/Tokyo。    |

`CODEX_HOME`は利用者入力として受けず、子processで`LUNA_HOME/codex`へ上書きする。子processは親環境を継承するが、`DISCORD_BOT_TOKEN`だけを除外する。

## 15. Thread保存

全Codex threadをdiskへ保存し、会話sessionまたはautomation実行終了時に`thread/archive`する。保持期間はarchive済みthreadを`thread/list`した結果の`updatedAt`から測る。archive失敗時はerror logを残してapplication参照を破棄し、未archive threadが残ることを許す。

startup直後と、前回清掃完了から`thread_cleanup_interval_ms`後ごとに、保持期限を過ぎたarchive済みthreadへ`thread/delete`を送る。delete失敗はlogに残し、次回清掃で再試行する。Discordからarchive済みthreadをresumeしない。

## 16. 障害、再起動、停止

| 事象                                                          | 結果                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Discord turn失敗                                              | logのみ。利用者通知と自動再実行なし。threadをarchiveしてsession終了。未開始queueは新threadへ移す。 |
| 初回履歴取得失敗                                              | 現在batchだけで続行。                                                                              |
| final output不正                                              | actionを実行せず、threadをarchiveしてsession終了。                                                 |
| Discord action失敗                                            | 全action settle後、同一thread follow-up。                                                          |
| RPC request timeout                                           | connection破損。全active turn失敗、全thread参照破棄、再起動。                                      |
| 管理中threadの相関不能、ID欠落、不正stdout JSON、未知response | process異常。全active turn失敗、再起動。                                                           |
| app-server停止                                                | active turnは再実行せず、thread参照を破棄。未開始queueは再起動後に新threadで処理。                 |
| final action中のapp-server停止                                | actionは全件settle。follow-upせずsession終了。未開始queueは新threadへ移す。                        |
| session記憶保存失敗                                           | error log後に再試行せずthreadをarchive。保存中のqueueは新threadへ移す。                            |
| 日次整理失敗                                                  | error log後にthreadをarchive。即時retryせず次のcron tickを待つ。                                   |
| 日次整理時にGit executableがない                              | Git操作を省略し、file整理を続行。                                                                  |
| `HEARTBEAT.md`読込失敗                                        | 当該heartbeatだけ失敗し、次の間隔を抽選。                                                          |
| 稼働中cron不正                                                | error log、last-validを維持。                                                                      |
| one-shot削除失敗                                              | error log、同一processでは再実行なし。以後は過去定義として削除だけを再試行。                       |
| thread archive/delete失敗                                     | error log、他処理を継続。                                                                          |

app-server再起動delayは`min(restart_initial_delay_ms × 2^(n-1), restart_max_delay_ms)`とする。`n`は`restart_window_ms`内にRESTARTINGへ入った回数である。process exit、protocol破損、RPC timeout、spawn失敗、initialize失敗をそれぞれ一回として数え、READYへ戻ってもwindow内の記録を消さない。`restart_failure_limit`回までは再起動し、その次にRESTARTINGが必要になった時点でLuna全体をnon-zero終了する。既定では1秒から30秒、5分内に5回までを許す。

SIGINTまたはSIGTERM後は新規Discord入力、heartbeat timer、schedule tick、日次整理tickを止める。signal前に受理した全queueとactive chainを、自然完了またはprocess異常まで待つ。正常完了した会話sessionは、idle期限前でもsession記憶保存を完了してからthreadをarchiveする。drain対象のconversation queueにapp-serverが必要なら再起動を続けるが、再起動budget超過時はnon-zero終了する。application内に追加grace timeoutは設けず、ComposeはSIGKILLまで60秒待つため、60秒を超えるshutdownはcontainer runtimeに終了される。

同時turn数、queue件数、queue byte数、turn時間、follow-up回数に上限を設けない。memory exhaustion、Bot loop、同一eventの重複処理、Gateway切断中の欠落、non-terminating shutdownを仕様上許容する。

## 17. ログと監視

logはJSON Linesとしてstdoutだけへ出す。保存とrotationは配置先へ委ねる。HTTP health endpointとstatus commandは提供せず、process livenessとexit codeだけで監視する。

通常はevent名、level、timestamp、conversation scope、job ID、thread ID、turn ID、request ID、action index等のmetadataを記録する。`LOG_LEVEL=debug`または`trace`ではDiscord本文、prompt、tool引数、actionも記録する。`DISCORD_BOT_TOKEN`等の既知の専用secret fieldはredactするが、free-form本文やpromptへ埋め込まれたcredentialや個人情報の検出・除去は保証しない。

## 18. 配置と品質

native macOS/LinuxとDockerを正式対応し、同じexact Node.js LTS patchをmise、Docker、CIで使う。Dockerは専用non-root userで実行し、そのuserへpasswordless sudoを与える。Composeはhostの`./data`をcontainerの`/home/node`へmountし、追加pathは利用者が明示する。publish imageはlinux/amd64とlinux/arm64を対象とする。

受入れにはformat、lint、knip、typecheck、testとlocal Docker image buildの成功を要求する。全体coverage率は要求せず、全状態遷移と各外部境界のsuccess、timeout、不正response、exceptionを契約testで固定する。prompt snapshotは固定developer instructionsと入力JSON組立だけに使う。実credentialによるlive E2EはREADMEの手順で利用者が行う。
