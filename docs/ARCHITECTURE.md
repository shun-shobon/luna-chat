# Luna Architecture

## 1. 設計目標

Lunaは、一つのprocess内で複数のDiscord会話と自律実行を並行処理するmodular hexagonal applicationとして構築する。設計上の優先順位は次のとおりである。

1. Discord、Codex、filesystem、clockをdomain/applicationから分離する。
2. 会話scopeごとの状態変更を直列化し、異なるscopeは並行させる。
3. 未検証の外部入力を境界でZod検証し、内部へ`unknown`を持ち込まない。
4. protocol破損と個別turn/Effect失敗の影響範囲を分ける。
5. service locator、DI framework、内部event busを使わない。

## 2. System context

```text
 Discord Gateway / REST
          │ events / reads / writes
          ▼
┌──────────────────────────────────────────────────────────────┐
│ Luna process                                                 │
│                                                              │
│  discord ─► LunaEvent ─► conversation ─┐                     │
│      ▲                                 ├─► agent runtime ─────────► Codex app-server
│      └──────── Discord Effect provider ◄┤        │            │
│                                        │        └─ loopback MCP
│  automation Event Sources ─► event one-shot executor ────────┘
│                                                              │
│  effect registry/output contract/batch executor              │
│  observability ◄──────── all capabilities                    │
│  runtime = composition root and lifecycle wiring only        │
└──────────────────────────────────────────────────────────────┘
          │
          └── LUNA_HOME / mounted filesystem / stdout
```

Codex app-serverはLunaのchild processであり、全threadが一つのprocessを共有する。Discord MCPはLuna process内で`127.0.0.1`へbindする。想定clientはCodexだが、認証がないため同じnetwork namespaceのlocal processも到達できる。

## 3. Source layout

```text
src/
├── modules/
│   ├── discord/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── ports/
│   │   └── adapters/
│   ├── conversation/
│   ├── agent/
│   ├── event/
│   ├── effect/
│   ├── automation/
│   ├── workspace/
│   └── observability/
├── runtime/
│   ├── composition-root.ts
│   ├── developer-instructions.ts
│   ├── runtime-environment.ts
│   └── thread-input-factory.ts
└── generated/codex/
```

各capabilityは必要なlayerだけを持つ。空のlayerや一つのclassだけを包むinterfaceは作らない。capabilityをまたぐbusiness ruleは、そのruleを実行する上位capabilityへ置く。

## 4. Capability ownership

| Capability      | 所有する概念                                                           | 公開するapplication境界                                         | Adapter                                     |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `discord`       | normalized message、scope、Discord Event/Effect、read、typing lease    | Event変換、Effect provider、Discord read、Gateway subscription  | discord.js Gateway/REST、loopback MCP       |
| `conversation`  | `ConversationSession`、pending Event、idle/close、session記憶、mailbox | `accept`、`typing`、`stopIntake`、`drain`、`abort`              | Discord controller/history                  |
| `agent`         | app-server process、thread、turn、notification correlation             | `openThread`、`startTurn`、`steer`、`archive`、`deleteArchived` | stdio child process、JSON-RPC               |
| `event`         | `LunaEvent`、one-shot実行                                              | `execute`                                                       | provider-neutral Agent adapter              |
| `effect`        | Effect定義、registry、出力契約、batch実行、result                      | schema生成、parse、`execute`、`release`                         | capability固有Effect provider               |
| `automation`    | heartbeat、schedule、日次整理というEvent Source、last-valid schedule   | `startAutomation`、`reloadSchedule`、`stopIntake`、`drain`      | clock、random、cron scheduler、file watcher |
| `workspace`     | Luna home、strict config、instructions、cron document                  | initialize、read instructions、read/write schedule              | filesystem、`smol-toml`、Zod                |
| `observability` | structured log、level、secret redaction、correlation context           | logger port                                                     | JSON Lines stdout                           |
| `runtime`       | object graph、startup/shutdown order                                   | process entry only                                              | signal handler                              |

`runtime`はbusiness ruleを持たない。Gateway callbackと`conversation.acceptMessage`の接続、MCP URLのagent設定への注入など、object graphのwiringだけを行う。

## 5. Dependency direction

domainは同じcapabilityのapplication/port/adapterをimportしない。applicationはdomainとportだけをimportする。adapterはapplication portを実装する。

capability間は所有側が公開したapplication portを直接`await`する。許可する主な方向は次のとおりである。

```text
discord      ──► event
conversation ──► event / effect / agent
automation   ──► event
event        ──► agent / effect
effect       ──► provider
automation   ──► workspace
all          ──► observability port
runtime      ──► all modules
```

Discord Gateway adapterはnormalized eventをcallbackへ渡すだけにし、`conversation`をimportしない。composition rootがcallbackを登録するため、`discord ↔ conversation`のcycleを作らない。

## 6. Domain model

### 6.1 Conversation scope

```ts
type ConversationScope =
  | { kind: "guild_channel"; guildId: string; channelId: string }
  | { kind: "guild_thread"; guildId: string; parentChannelId: string; threadId: string }
  | { kind: "dm"; channelId: string; userId: string };
```

文字列key化はmemory session store adapterだけが行う。domain equalityはunion fieldで比較する。

### 6.2 Message

messageは`human`、`bot`、`webhook`、`system`の判別可能unionとする。共通fieldにmessage ID、timestamp、scope、author、content、attachment、sticker、reaction、mention、reply referenceを持つ。Gateway入力はこれらに加え、Discord.jsキャッシュがLuna自身のthread memberを保持するかをbooleanで持つ。raw discord.js objectをdomainへ保持しない。

### 6.3 共通Eventと会話session

`LunaEvent`は全入力源が共用する検証済みenvelopeである。

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

Discordは`discord.message.created.v1`を生成し、`data`へscopeとnormalized messageを格納する。`ConversationSession.key`はscopeを一意に表し、`context`はDiscord scopeを保持する。会話入力ではsession identityだけをAgentへ渡し、scopeとmessageはEventから読む。

### 6.4 Session state

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
     │                                any failure   │           │ all success / empty
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

`OPENING_THREAD`はsession初回だけ使う。既存threadを持つ`IDLE`からの次投稿は、履歴取得と`thread/start`を繰り返さず、debounce後に`STARTING_TURN`へ進む。

全stateでidle expiryを受けられる。active stateでは`closeAfterCompletion = true`を付け、chainを中断しない。その後に受理投稿が来ればidle期限をresetしてclose予約を取り消す。close予約が残ったままchainを完了するかidle stateの期限が来ると、session記憶保存を開始する。保存開始後の投稿はclose予約を取り消さず、次thread用queueへ入れる。

### 6.5 State transition contract

| 現在                                            | event                              | 次                  | 作用                                                       |
| ----------------------------------------------- | ---------------------------------- | ------------------- | ---------------------------------------------------------- |
| absent                                          | accepted input                     | collecting          | session作成、idle reset、batchへ追加                       |
| collecting                                      | accepted input                     | collecting          | batchへ追加、debounce/idle reset                           |
| collecting                                      | dispatch ready、threadなし         | opening thread      | 初回history取得、instructions読込、`thread/start`          |
| collecting                                      | dispatch ready、threadあり         | starting turn       | 既存threadで`turn/start`                                   |
| idle                                            | accepted input                     | collecting          | 既存thread維持、batch追加、idle reset                      |
| conversation opening/starting/followup starting | accepted input                     | 同じstate           | queueへ追加、idle reset、close予約取消                     |
| starting turn / followup starting               | `turn/start` response              | turn active         | turn ID保存、starting中queueを受信順にsteer                |
| turn active                                     | accepted input、final未受領        | turn active         | idle reset、close予約取消、即時steer。失敗分はqueue        |
| turn active                                     | accepted input、final受領済み      | turn active         | runtimeがsteerをRPC送信前に拒否し、queueへ移す             |
| turn active                                     | turn success                       | effects active      | final JSON検証、Effect全件を並行開始                       |
| turn active                                     | turn failureまたはfinal JSON不正   | archiving           | log、typing cleanup、thread archive。未開始queue維持       |
| conversation effects active                     | accepted input                     | effects active      | queueへ追加、idle reset、close予約取消                     |
| conversation effects active                     | all settled、failureあり           | followup starting   | typing cleanup、全resultで同一thread `turn/start`          |
| conversation effects active                     | all success/empty、queueあり       | collecting          | typing cleanup、chain完了、queueをbatch化                  |
| conversation effects active                     | all success/empty、queueなし       | idle/session memory | typing cleanup、idle reset。close予約/shutdown時は記憶保存 |
| opening/turn/followup start failure             | failure                            | archiving           | log、可能ならthread archive、session終了                   |
| active state                                    | idle expired                       | 同じstate           | close予約のみ。後続accepted inputで取消可能                |
| idle                                            | idle expired、memory無効           | archiving           | `thread/archive`                                           |
| idle                                            | idle expired、memory有効           | session memory      | local dateを生成し、同一threadで`turn/start`               |
| session memory start/turn/effects               | accepted input                     | 同じstate           | steerせず次thread用queueへ追加                             |
| session memory turn                             | turn success                       | effects active      | 通常turnと同じEffect実行                                   |
| session memory effects                          | failureあり                        | followup starting   | 同じ保存目的を保ったEffect result follow-up                |
| session memory effects                          | all success/empty                  | archiving           | typing cleanup後に`thread/archive`                         |
| session memory start/turn failure               | failure                            | archiving           | log後にretryせず`thread/archive`                           |
| archiving                                       | archive success/failure、queueなし | absent              | 成功時刻をretention起算に記録。失敗も参照破棄              |
| archiving                                       | archive success/failure、queueあり | collecting          | 参照破棄後、queueを新thread用batchへ移す                   |
| effects active                                  | app-server lost                    | effects orphaned    | thread参照破棄。開始済みEffectは継続、follow-up禁止        |
| effects orphaned                                | accepted input                     | effects orphaned    | queueへ追加、idle reset                                    |
| effects orphaned                                | all settled                        | collecting/absent   | typing cleanup、resultをlog。queueは新threadへ移す         |
| effects active以外                              | app-server lost                    | collecting/absent   | active失敗、thread参照破棄、未開始queueだけ維持            |

会話scopeごとにmailbox型actorを一つ持つ。actorはstate mutationだけを短いcommandとして直列処理し、長時間の外部I/O Promiseをmailbox内でawaitしない。I/O開始時にstateとoperation tokenを記録し、完了を新しいmailbox messageとして戻す。これによりturn完了待機中もaccepted inputを処理し、即時steerできる。古いoperation tokenの完了は無視する。

## 7. Event/Effect orchestration

`agent`はprovider-neutralなthread/turn protocolと相関だけを所有する。呼出側がJSON文字列の`input`と`outputSchema`を渡し、runtimeは最終assistant messageをraw `outputText`として返す。Discord型、Effect型、出力parseは`agent`へ置かない。

`effect`のregistryは一意なEffect typeとproviderを対応づける。registryから`EffectOutputContract`がStructured Outputs schemaを構築し、raw出力を`{effects: EffectRequest[]}`へ検証する。batch executorは各Effectをproviderへ並行委譲し、元index、type、target、success valueまたはerrorを`EffectResult`へ保持する。

Discord会話では即時steerとmailbox stateを統合するため`conversation`がchainを進める。automationの3 Event Sourceは共通`EventExecutor`と`EventAgentAdapter`を使い、Eventごとにone-shot threadを開く。両経路は次のEffect chainに従う。

```text
validated input
     │
     ├─ new thread: load LUNA + MEMORY, thread/start
     │
     ├─ turn/start(outputSchema)
     │       ├─ MCP read/write calls occur immediately
     │       └─ wait for correlated completion notification (no overall timeout)
     │
     ├─ EffectOutputContract.parse(raw outputText)
     │
     ├─ EffectBatchPort.execute(effects, ownerId)
     ├─ EffectBatchPort.release(ownerId)
     │
     ├─ no failure ───────────────────────────────► complete
     │
     └─ any failure ─► turn/start(effect_results) ─┐
                                                   └─ repeat without limit
```

MCP操作はCodexが呼んだ時点で実行する。final Effectはturn完了後に全件並行実行する。MCP履歴を見てEffectを暗黙抑止しない。final出力のparse失敗時はEffectを一件も実行しない。

follow-up turn中に新しいDiscord投稿が来た場合、そのfollow-upが現在のactive turnなのでfinal agent message受領前だけ即時steerする。follow-upの`turn/start` response前、final agent message受領後、Effect実行中にはsteer可能なCodex turnがないため、投稿をqueueへ入れる。response後はstarting中queueを順にsteerし、chain終了時に残るqueueは新しいbatchとして処理する。

会話turnは`{source:"conversation",session:{key,source},history,events}`、one-shot Eventは`{source:"event",event}`を送る。失敗follow-upは`{source:"effect_results",results}`、session記憶保存は`{source:"session_memory",date}`を使う。session memoryでも同じEffect contractを使い、全Effect成功後だけarchiveする。通常chain失敗とfatal abortはsession記憶保存を経由しない。

## 8. Codex app-server adapter

### 8.1 Process lifecycle

```text
STOPPED ── spawn/initialize ──► READY
   ▲                              │ protocol/process failure
   │                              ▼
   └──── backoff ◄──────────── RESTARTING
                                  │ restart budget exceeded
                                  ▼
                                FATAL
```

child executableはpnpm dependencyの`@openai/codex`だけから絶対pathで解決する。child environmentは親をcopyし、`DISCORD_BOT_TOKEN`を削除し、`CODEX_HOME`を上書きする。

全RPC pending requestはrequest IDで管理し、共通timeoutを持つ。いずれか一件のtimeoutでもserver側だけ成功した未知状態を否定できないため、connection全体を破損とみなす。Lunaが開始してarchive処理を終えるまでのthread IDを管理中集合へ置き、そのthreadのturn notificationだけをthread IDとturn IDの両方でtrackerへroutingする。Codexが同じconnectionへ配信するsubagent等の管理外thread notificationはtrackerへ渡さない。管理中threadのtracker不在、ID欠落、不一致、decode不能なstdout行、未知responseは同じprocess異常とする。

trackerはfinal agent messageを受領した時点でturnをsteer不能として公開する。runtimeは`turn/steer`のRPC送信前にこの状態を検査して拒否し、application側は失敗した入力を次turn用queueへ戻す。これにより`turn/completed`待機中に後続steerがfinal messageを上書きせず、確定したEffectを先に実行する。

process異常では全pending requestとactive turnをtyped errorでrejectし、全thread referenceを破棄する。未開始conversation queueは保持する。実行中のEffectはapp-serverと独立して全件settleさせるが、result follow-upは行わない。one-shot Event executionは失敗として再実行せず、heartbeatは次間隔を抽選し、recurring jobは次tickを待ち、one-shot scheduleは過去定義として削除だけを再試行する。

RESTARTINGへ入ったtimestampをsliding windowで保持する。process exit、protocol破損、RPC timeout、spawn失敗、initialize失敗を一回と数え、READYへ戻ってもwindow内の記録をclearしない。delayは`min(initial × 2^(n-1), max)`で計算する。window内で設定回数まで再起動し、その次のfaultでFATALへ進む。

### 8.2 Thread lifecycle

```text
thread/start(ephemeral=false)
  └─ zero or more turn chains
       ├─ idle終了する会話だけsession memory chain
       └─ session/job end
            └─ thread/archive
                 └─ retention elapsed
                      └─ thread/delete
```

applicationの`close`は「新規入力を受けず、chain完了後にarchiveし、memory参照を破棄する」操作である。Codex protocolに`thread/close`を想定しない。

retention cleanerはstartup直後と前回完了から24時間後に、専用CODEX_HOMEのarchive済みthreadを列挙する。`thread/list`結果の`updatedAt`から保持期間を測り、期限超過だけをdeleteする。時刻が得られないthreadは削除せずwarningを記録する。失敗itemは次回へ残す。

## 9. Discord adapters

### 9.1 Gateway

Gateway adapterは必要intentsとDM channel partialを設定し、`messageCreate`とtyping eventだけを購読する。`messageCreate`変換時にthread channelの`members.me`を読み、Discord.jsキャッシュ上のLuna自身のthread member有無を検証済みbooleanとして渡す。RESTによる追加取得は行わない。受付policy、session有無、batchingはconversation applicationに置く。

初回historyは最初のbatchより前をcursor指定して取得する。historyと起点event間だけIDでdedupeし、event同士はdedupeしない。

### 9.2 Discord Effect provider

providerは次の6 Effectをregistryへ登録する。

- `discord.send_message`
- `discord.reply_message`
- `discord.add_reaction`
- `discord.remove_reaction`
- `discord.start_typing`
- `discord.stop_typing`

各Effect inputをZodで検証し、既存のDiscord application portが扱うcommandへ変換する。send/replyはDiscord制限、attachment realpath、通常file、readabilityをAPI call前に検証する。reply失敗をsendへ変換しない。rate limitとnetwork errorは追加retryせず、一つのEffect failureとして返す。

### 9.3 Typing

typing registryはtargetとthread固有ownerに紐づくleaseをmemoryで保持し、Discord typing期限より短い固定間隔で更新する。一つのthreadにactive turnは一つだけなので、thread作成前に生成したowner IDをMCP HTTP headerとEffect実行へ共通利用し、各batch settle後、follow-up開始前にそのownerの残存leaseを解放する。`discord.stop_typing`は指定targetの呼出owner leaseを解放する。

cleanupのDiscord API失敗はerror logへ残すが、完了済みchainを再開しない。session closeとprocess shutdownでは全leaseをbest effortで停止する。

### 9.4 MCP

MCP adapterはDiscord read/write application portをtoolごとに薄く公開する。generic REST toolを持たない。serverはloopbackのrandom portへbindし、起動後に得たURLをcapability固有instructionsとともにprovider-neutralなthread input factoryへ渡す。bind失敗はstartup failure、稼働中transport errorは該当tool failureとしてCodexへ返す。

## 10. Workspace adapters

startup initializerは`LUNA_HOME`が絶対pathであることを確認し、home、workspace、codex directoryを作る。`config.toml`と`cron.toml`がなければ完全な既定内容を生成する。`memory/`はinitializerで作らない。directory作成、初期file生成、main config parse失敗はstartup failureである。

TOMLは`smol-toml`で`unknown`へparseし、strict Zod schemaで検証する。main configの`memory` sectionは必須とし、自動migrationしない。memory cronと利用者schedule cronは同じ5-field検証関数を使う。main configはstartup後に再読込しない。cron watcherは変更をdebounceして全fileを再検証し、成功時だけlast-valid snapshotを置換する。

one-shot削除は最新snapshotを同期再読込し、IDで除外後に全体をserializeして同じpathへ直接writeする。write失敗後もscheduler上の発火済みjobは解除する。watcher reloadまたはprocess再起動後は時刻が過去なので実行せず、削除だけを再試行する。実行済みledgerは作らない。

## 11. Automation

`automation`のcontrollerはAgent入力を直接構築しない。heartbeat、schedule、日次整理は、それぞれ次の`LunaEvent`を生成するEvent Sourceである。

| `source`                    | Event type                           | `data`                |
| --------------------------- | ------------------------------------ | --------------------- |
| `system/heartbeat`          | `system.heartbeat.fired.v1`          | `{checklist}`         |
| `system/schedule`           | `system.schedule.fired.v1`           | `{jobId,prompt,kind}` |
| `system/memory-maintenance` | `system.memory_maintenance.fired.v1` | `{date}`              |

各Eventは共通one-shot executorへ直接`await`される。内部event bus、永続queue、delivery retryはない。executorはEventごとにthreadを開き、`{source:"event",event}`でturnを開始し、Effect chain完了後にarchiveする。

### 11.1 Heartbeat

```text
WAITING ── timer ──► READING ──► RUNNING ──► ARCHIVING
   ▲                    │ failure                 │
   └──── random next ◄──┴─────────────────────────┘
```

timerは前回処理完了後にだけ設定する。`HEARTBEAT.md`読込失敗も一回の完了として次間隔を抽選する。process停止中の予定時刻は保存もcatch-upもしない。

### 11.2 Schedule

recurring tickは同じjob IDでも独立実行し、global lockを取らない。one-shotは`turn/start` responseを受けた直後にfile削除を試みるため、turn結果に関係なくscheduler上のjobを解除する。

past one-shotはreload時に実行対象へ登録せず、正規化writeで削除する。write失敗時はerror logを残し、次reloadで削除を再試行するが実行しない。

### 11.3 記憶とworkspaceの日次整理

memory maintenance controllerはstartup時の`enabled`と5-field cronを受け取り、有効時だけrecurring timerを一件登録する。tick時のprocess local dateを`system.memory_maintenance.fired.v1`の`data.date`へ格納する。専用threadのopen、Effect follow-up、archive、失敗logはheartbeatとscheduleと同じEvent executor/Agent adapterを再利用する。

controllerはactive executionをdrain対象として追跡するが、同時実行guardと完了timeoutを持たない。停止中tickのledgerとcatch-upも作らない。通常会話、session記憶保存、他automationとのworkspace排他を取らない。

file整理とGit操作はapplication portへ分解せず、固定developer instructionsに従うCodex threadへ任せる。Git executableがなければGitだけを省略する明示的fallbackとする。成功・失敗報告だけを目的とするDiscord通知は禁止する。applicationはcommitの有無、stage対象、working tree状態を検証しない。

## 12. Startup and shutdown

### 12.1 Startup

```text
validate env
  → initialize LUNA_HOME and workspace files
  → parse config.toml and cron.toml
  → initialize JSON logger
  → create Discord client and REST adapter
  → start loopback MCP
  → spawn and initialize Codex app-server
  → login Discord and resolve Luna user
  → run archived-thread cleanup
  → start Gateway intake, heartbeat, memory maintenance, cron watcher/scheduler
```

途中失敗は作成済みresourceを逆順にcloseし、non-zero終了する。

### 12.2 Shutdown

```text
SIGINT / SIGTERM
  → stop Gateway intake, heartbeat timer, memory maintenance, and new schedule ticks
  → freeze accepted-work frontier
  → drain pre-signal conversation queues and active chains
  → preserve each successfully completed conversation session
  → wait active heartbeat/schedule/memory maintenance chains
  → archive completed threads
  → stop typing leases, watchers, MCP, Discord, app-server
  → flush stdout logger
```

application内のdrainへgrace timeoutを設けない。無限turnまたはfollow-upがある場合、後続closeへ到達しない。Composeは`stop_grace_period: 60s`によりSIGTERMからSIGKILLまで60秒待つ。

drain対象の未開始conversation queueが残る間にapp-serverが失われた場合は、通常のrestart budget内で再起動して新threadで処理する。active automationは失敗終了し、shutdown中に新しいautomation実行を作らない。budget超過はFATAL終了とする。

## 13. Concurrency and delivery

- conversation scope内のstate mutationは直列、scope間は並列。
- conversation、session記憶保存、heartbeat、schedule、日次整理を合わせたglobal concurrency上限なし。
- recurring jobの同一ID tickも並列。
- Effectは配列全件並列。
- queue sizeとbyte上限なし。
- Gateway eventはat-most-once、at-least-once、exactly-onceのいずれもapplicationとして保証しない。
- app-server crash時はactive処理を再実行せず、未開始queueだけを新threadへ移す。

この設計はresource exhaustion、外部API burst、Bot loop、永久shutdownを意図的に防止しない。実装で暗黙のsemaphore、retry、dedupe cacheを追加してはならない。

## 14. Observability

logger portはstructured eventとcorrelation contextを受け取り、stdoutへ一行一JSONを出す。`DISCORD_BOT_TOKEN`、authorization header等の既知fieldは名前と型でredactし、free-form errorをserializable shapeへ変換する。本文、prompt、path、tool引数内に埋め込まれた未知credentialや個人情報のredactionは保証しない。

主要correlation fieldは`conversationScope`、`jobId`、`threadId`、`turnId`、`requestId`、`toolCallId`、`effectIndex`、`typingLeaseId`である。debug/traceだけpayloadを含める。

## 15. Validation policy

次を外部入力として境界で検証する。

- environment variableとTOML parse結果。
- discord.js eventから抽出したoptional data。
- Codex JSON-RPC stdoutとserver request。
- Codex final JSON。
- MCP tool arguments。
- Discord SDK/API responseでapplicationが依存するfield。

`JSON.parse`結果、SDK response、environment/configへ`as`を使わない。生成されたCodex判別unionを優先し、足りない境界はZodまたはtype guardで狭める。`as unknown as`と`as any`は禁止する。

## 16. Test architecture

global coverage thresholdは設けない。

| Test layer              | 必須範囲                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| domain unit             | 全session状態遷移、禁止遷移、LunaEvent、ConversationSession、Effect contract       |
| application contract    | batch/steer順序、idle記憶保存、follow-up、heartbeat、日次整理、one-shot、retention |
| adapter contract        | Gateway、REST、MCP、JSON-RPC、child process、filesystem、clock、random、logger     |
| failure matrix          | 各外部境界のsuccess、timeout、不正response、exception                              |
| concurrency             | scope別executor、並行turn、並行Effect、shutdown drain、restart中queue              |
| config                  | strict key、必須memory section、既定値、cron、関係constraint、正規化rewrite        |
| snapshot                | 固定developer instructionsと入力JSON組立だけ                                       |
| composition integration | fake Discord Gateway/APIとfake app-server child processでstartupからshutdownまで   |
| manual E2E              | 実Discordと実Codex。READMEの手順を利用者が実行                                     |

Codex generated typeはGit追跡せず、固定版CLIからlocal bootstrapとCIで生成する。tsdown buildではnf3 pluginがruntimeで参照する外部依存を追跡し、`dist/node_modules`へ必要なfileだけを配置する。Docker runtime imageはこの追跡済み依存を使い、production依存全体を再installしない。quality gateはformat、lint、knip、typecheck、testとし、実装完了時にlocal Docker buildも行う。build jobは通常CI gateへ加えず、image publishでamd64/arm64 buildを行う。

## 17. Composition

composition rootはDiscord Effect providerからregistry、出力契約、batch executorを一度だけ構築し、conversationとEvent one-shotの両経路へ同じinstanceを注入する。Agent thread input factoryにはworkspace、固定developer instructions、Discord capability instructions、owner IDごとのMCP設定を渡す。module間はapplication portを直接`await`し、内部event busとDI frameworkは置かない。
