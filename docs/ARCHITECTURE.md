# Luna Architecture

## 1. 設計目標

Lunaは、一つのprocess内で複数のDiscord会話と自律実行を並行処理するmodular hexagonal applicationとして構築する。設計上の優先順位は次のとおりである。

1. Discord、Codex、filesystem、clockをdomain/applicationから分離する。
2. 会話scopeごとの状態変更を直列化し、異なるscopeは並行させる。
3. 未検証の外部入力を境界でZod検証し、内部へ`unknown`を持ち込まない。
4. protocol破損と個別turn/action失敗の影響範囲を分ける。
5. 互換layer、service locator、DI framework、内部event busを使わない。

## 2. System context

```text
 Discord Gateway / REST
          │ events / reads / writes
          ▼
┌─────────────────────────────────────────────────────────┐
│ Luna process                                            │
│                                                         │
│  discord ──► conversation ──► agent ──► workspace       │
│     ▲              │             │                      │
│     │              │             ├── stdio JSON-RPC ───────► Codex app-server
│     │              │             │                      │
│     └──── loopback MCP ◄──────────┘                      │
│                            ▲                            │
│  automation ───────────────┘                            │
│                                                         │
│  observability ◄──────── all capabilities               │
│  runtime = composition root and lifecycle wiring only   │
└─────────────────────────────────────────────────────────┘
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

| Capability      | 所有する概念                                                                 | 公開するapplication境界                                               | Adapter                                      |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `discord`       | normalized message、scope metadata、Discord action、read query、typing lease | message normalize、action execute、Discord read、Gateway subscription | discord.js Gateway/REST、loopback MCP        |
| `conversation`  | session、pending batch、idle/close状態、scope executor                       | `acceptMessage`、`acceptTyping`、`drain`                              | memory session store、timer                  |
| `agent`         | app-server process、thread、turn、notification correlation                   | `openThread`、`startTurn`、`steer`、`archive`、`deleteArchived`       | stdio child process、JSON-RPC、output schema |
| `automation`    | heartbeat state、schedule job、last-valid schedule                           | `startAutomation`、`reloadSchedule`、`stopIntake`、`drain`            | clock、random、cron scheduler、file watcher  |
| `workspace`     | Luna home、strict config、instructions、cron document                        | initialize、read instructions、read/write schedule                    | filesystem、`smol-toml`、Zod                 |
| `observability` | structured event、level、secret redaction、correlation context               | logger port                                                           | JSON Lines stdout                            |
| `runtime`       | object graph、startup/shutdown order                                         | process entry only                                                    | signal handler                               |

`runtime`はbusiness ruleを持たない。Gateway callbackと`conversation.acceptMessage`の接続、MCP URLのagent設定への注入など、object graphのwiringだけを行う。

## 5. Dependency direction

domainは同じcapabilityのapplication/port/adapterをimportしない。applicationはdomainとportだけをimportする。adapterはapplication portを実装する。

capability間は所有側が公開したapplication portを直接`await`する。許可する主な方向は次のとおりである。

```text
conversation ──► agent
conversation ──► discord
automation   ──► agent
automation   ──► discord
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

messageは`human`、`bot`、`webhook`、`system`の判別可能unionとする。共通fieldにmessage ID、timestamp、scope、author、content、attachment、sticker、reaction、mention、reply referenceを持つ。raw discord.js objectをdomainへ保持しない。

### 6.3 Session state

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
     │                                             ACTIONS_ACTIVE
     │                                              │           │
     │                                any failure   │           │ all success / empty
     │                                              ▼           ▼
     │                                     FOLLOWUP_STARTING   IDLE
     │                                              │           │
     └──────── queued input after chain ────────────┴───────────┘
                                                                │ idle deadline
                                                                ▼
                                                           ARCHIVING ──► ABSENT
```

`OPENING_THREAD`はsession初回だけ使う。既存threadを持つ`IDLE`からの次投稿は、履歴取得と`thread/start`を繰り返さず、debounce後に`STARTING_TURN`へ進む。

全stateでidle expiryを受けられる。active stateでは`closeAfterCompletion = true`を付け、chainを中断しない。その後に受理投稿が来ればidle期限をresetしてclose予約を取り消す。chain完了時にqueueがあればarchiveよりqueue処理を優先する。

### 6.4 State transition contract

| 現在                                               | event                              | 次                  | 作用                                                 |
| -------------------------------------------------- | ---------------------------------- | ------------------- | ---------------------------------------------------- |
| absent                                             | accepted input                     | collecting          | session作成、idle reset、batchへ追加                 |
| collecting                                         | accepted input                     | collecting          | batchへ追加、debounce/idle reset                     |
| collecting                                         | dispatch ready、threadなし         | opening thread      | 初回history取得、instructions読込、`thread/start`    |
| collecting                                         | dispatch ready、threadあり         | starting turn       | 既存threadで`turn/start`                             |
| idle                                               | accepted input                     | collecting          | 既存thread維持、batch追加、idle reset                |
| opening thread / starting turn / followup starting | accepted input                     | 同じstate           | queueへ追加、idle reset、close予約取消               |
| starting turn / followup starting                  | `turn/start` response              | turn active         | turn ID保存、starting中queueを受信順にsteer          |
| turn active                                        | accepted input                     | turn active         | idle reset、close予約取消、即時steer。失敗分はqueue  |
| turn active                                        | turn success                       | actions active      | final JSON検証、action全件を並行開始                 |
| turn active                                        | turn failureまたはfinal JSON不正   | archiving           | log、typing cleanup、thread archive。未開始queue維持 |
| actions active                                     | accepted input                     | actions active      | queueへ追加、idle reset、close予約取消               |
| actions active                                     | all settled、failureあり           | followup starting   | typing cleanup、全resultで同一thread `turn/start`    |
| actions active                                     | all success/empty、queueあり       | collecting          | typing cleanup、chain完了、queueをbatch化            |
| actions active                                     | all success/empty、queueなし       | idleまたはarchiving | typing cleanup、idle reset。close予約時はarchive     |
| opening/turn/followup start failure                | failure                            | archiving           | log、可能ならthread archive、session終了             |
| active state                                       | idle expired                       | 同じstate           | close予約のみ。後続accepted inputで取消可能          |
| idle                                               | idle expired                       | archiving           | `thread/archive`                                     |
| archiving                                          | archive success/failure、queueなし | absent              | 成功時刻をretention起算に記録。失敗も参照破棄        |
| archiving                                          | archive success/failure、queueあり | collecting          | 参照破棄後、queueを新thread用batchへ移す             |
| actions active                                     | app-server lost                    | actions orphaned    | thread参照破棄。開始済みactionは継続、follow-up禁止  |
| actions orphaned                                   | accepted input                     | actions orphaned    | queueへ追加、idle reset                              |
| actions orphaned                                   | all settled                        | collecting/absent   | typing cleanup、resultをlog。queueは新threadへ移す   |
| actions active以外                                 | app-server lost                    | collecting/absent   | active失敗、thread参照破棄、未開始queueだけ維持      |

会話scopeごとにmailbox型actorを一つ持つ。actorはstate mutationだけを短いcommandとして直列処理し、長時間の外部I/O Promiseをmailbox内でawaitしない。I/O開始時にstateとoperation tokenを記録し、完了を新しいmailbox messageとして戻す。これによりturn完了待機中もaccepted inputを処理し、即時steerできる。古いoperation tokenの完了は無視する。

## 7. Turn chain orchestration

`agent`はthread/turnのprotocol操作と相関だけを所有する。Discord会話では即時steerとmailbox stateを統合する必要があるため`conversation`がchainを進め、automationでは`automation`がjob単位のchainを進める。どちらも次の同一契約に従う。

```text
validated input
     │
     ├─ new thread: load LUNA + MEMORY, thread/start
     │
     ├─ turn/start(outputSchema)
     │       ├─ MCP read/write calls occur immediately
     │       └─ wait for correlated completion notification (no overall timeout)
     │
     ├─ parse JSON + Zod
     │
     ├─ Promise.allSettled(final actions)
     ├─ release typing leases owned by this turn
     │
     ├─ no failure ───────────────────────────────► complete
     │
     └─ any failure ─► turn/start(action results) ─┐
                                                   └─ repeat without limit
```

MCP操作はCodexが呼んだ時点で実行する。final actionはturn完了後に全件並行実行する。MCP履歴を見てfinal actionを暗黙抑止しない。

follow-up turn中に新しいDiscord投稿が来た場合、そのfollow-upが現在のactive turnなので即時steerする。follow-upの`turn/start` response前とaction実行中にはactive Codex turnがないため、投稿をqueueへ入れる。response後はstarting中queueを順にsteerし、chain終了時に残るqueueは新しいbatchとして処理する。

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

全RPC pending requestはrequest IDで管理し、共通timeoutを持つ。いずれか一件のtimeoutでもserver側だけ成功した未知状態を否定できないため、connection全体を破損とみなす。thread/turn notificationはthread IDとturn IDの両方でtrackerへroutingする。ID欠落、不一致、decode不能なstdout行、未知responseも同じprocess異常とする。

process異常では全pending requestとactive turnをtyped errorでrejectし、全thread referenceを破棄する。未開始conversation queueは保持する。実行中のDiscord final actionはapp-serverと独立して全件settleさせるが、result follow-upは行わない。automation executionは失敗として再実行せず、heartbeatは次間隔を抽選し、recurring jobは次tickを待ち、one-shotは過去定義として削除だけを再試行する。

RESTARTINGへ入ったtimestampをsliding windowで保持する。process exit、protocol破損、RPC timeout、spawn失敗、initialize失敗を一回と数え、READYへ戻ってもwindow内の記録をclearしない。delayは`min(initial × 2^(n-1), max)`で計算する。window内で設定回数まで再起動し、その次のfaultでFATALへ進む。

### 8.2 Thread lifecycle

```text
thread/start(ephemeral=false)
  └─ zero or more turn chains
       └─ session/job end
            └─ thread/archive
                 └─ retention elapsed
                      └─ thread/delete
```

applicationの`close`は「新規入力を受けず、chain完了後にarchiveし、memory参照を破棄する」操作である。Codex protocolに`thread/close`を想定しない。

retention cleanerはstartup直後と前回完了から24時間後に、専用CODEX_HOMEのarchive済みthreadを列挙する。`thread/list`結果の`updatedAt`から保持期間を測り、期限超過だけをdeleteする。時刻が得られないthreadは削除せずwarningを記録する。失敗itemは次回へ残す。

## 9. Discord adapters

### 9.1 Gateway

Gateway adapterは必要intentsとDM channel partialを設定し、`messageCreate`とtyping eventだけを購読する。受付policy、session有無、batchingはconversation applicationに置く。

初回historyは最初のbatchより前をcursor指定して取得する。historyと起点event間だけIDでdedupeし、event同士はdedupeしない。

### 9.2 REST action executor

すべてのaction inputをZodで検証し、明示targetをDiscord API objectへ解決する。send/replyはDiscord制限、attachment realpath、通常file、readabilityをAPI call前に検証する。reply失敗をsendへ変換しない。

final action executorは`Promise.allSettled`を使い、resultへaction index、action kind、target、success valueまたはserializable errorを付ける。rate limitとnetwork errorはDiscord adapterが勝手に追加retryせず、discord.jsの契約結果を一つのaction failureとして返す。

### 9.3 Typing

typing registryはtargetとthread固有ownerに紐づくleaseをmemoryで保持し、Discord typing期限より短い固定間隔で更新する。一つのthreadにactive turnは一つだけなので、thread作成前に生成したowner IDをMCP HTTP headerとfinal actionへ共通利用し、各turnのfinal action settle後、follow-up開始前にそのownerの残存leaseを解放する。明示`stop_typing`は指定targetの呼出owner leaseを解放する。

cleanupのDiscord API失敗はerror logへ残すが、完了済みchainを再開しない。session closeとprocess shutdownでは全leaseをbest effortで停止する。

### 9.4 MCP

MCP adapterはDiscord read/action application portをtoolごとに薄く公開する。generic REST toolを持たない。serverはloopbackのrandom portへbindし、起動後に得たURLをthread configへ注入する。bind失敗はstartup failure、稼働中transport errorは該当tool failureとしてCodexへ返す。

## 10. Workspace adapters

startup initializerは`LUNA_HOME`が絶対pathであることを確認し、home、workspace、codex directoryを作る。`config.toml`と`cron.toml`がなければ完全な既定内容を生成する。directory作成、初期file生成、main config parse失敗はstartup failureである。

TOMLは`smol-toml`で`unknown`へparseし、strict Zod schemaで検証する。main configはstartup後に再読込しない。cron watcherは変更をdebounceして全fileを再検証し、成功時だけlast-valid snapshotを置換する。

one-shot削除は最新snapshotを同期再読込し、IDで除外後に全体をserializeして同じpathへ直接writeする。write失敗後もscheduler上の発火済みjobは解除する。watcher reloadまたはprocess再起動後は時刻が過去なので実行せず、削除だけを再試行する。実行済みledgerは作らない。

## 11. Automation

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
  → start Gateway intake, heartbeat, cron watcher/scheduler
```

途中失敗は作成済みresourceを逆順にcloseし、non-zero終了する。

### 12.2 Shutdown

```text
SIGINT / SIGTERM
  → stop Gateway intake, heartbeat timer, and new schedule ticks
  → freeze accepted-work frontier
  → drain pre-signal conversation queues and active chains
  → wait active heartbeat/schedule chains
  → archive completed threads
  → stop typing leases, watchers, MCP, Discord, app-server
  → flush stdout logger
```

drainへgrace timeoutを設けない。無限turnまたはfollow-upがある場合、後続closeへ到達しない。

drain対象の未開始conversation queueが残る間にapp-serverが失われた場合は、通常のrestart budget内で再起動して新threadで処理する。active automationは失敗終了し、shutdown中に新しいautomation実行を作らない。budget超過はFATAL終了とする。

## 13. Concurrency and delivery

- conversation scope内のstate mutationは直列、scope間は並列。
- conversation、heartbeat、scheduleを合わせたglobal concurrency上限なし。
- recurring jobの同一ID tickも並列。
- final actionは配列全件並列。
- queue sizeとbyte上限なし。
- Gateway eventはat-most-once、at-least-once、exactly-onceのいずれもapplicationとして保証しない。
- app-server crash時はactive処理を再実行せず、未開始queueだけを新threadへ移す。

この設計はresource exhaustion、外部API burst、Bot loop、永久shutdownを意図的に防止しない。実装で暗黙のsemaphore、retry、dedupe cacheを追加してはならない。

## 14. Observability

logger portはstructured eventとcorrelation contextを受け取り、stdoutへ一行一JSONを出す。`DISCORD_BOT_TOKEN`、authorization header等の既知fieldは名前と型でredactし、free-form errorをserializable shapeへ変換する。本文、prompt、path、tool引数内に埋め込まれた未知credentialや個人情報のredactionは保証しない。

主要correlation fieldは`conversationScope`、`jobId`、`threadId`、`turnId`、`requestId`、`toolCallId`、`actionIndex`、`typingLeaseId`である。debug/traceだけpayloadを含める。

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

旧test suiteは削除し、新しいcontractから作り直す。global coverage thresholdは設けない。

| Test layer              | 必須範囲                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| domain unit             | 全session状態遷移、禁止遷移、scope equality、job union、action union             |
| application contract    | batch/steer順序、idle/close、follow-up、heartbeat、one-shot、retention           |
| adapter contract        | Gateway、REST、MCP、JSON-RPC、child process、filesystem、clock、random、logger   |
| failure matrix          | 各外部境界のsuccess、timeout、不正response、exception                            |
| concurrency             | scope別executor、並行turn、並行action、shutdown drain、restart中queue            |
| config                  | strict key、全省略、全既定値、関係constraint、正規化rewrite                      |
| snapshot                | 固定developer instructionsと入力JSON組立だけ                                     |
| composition integration | fake Discord Gateway/APIとfake app-server child processでstartupからshutdownまで |
| manual E2E              | 実Discordと実Codex。READMEの手順を利用者が実行                                   |

Codex generated typeはGit追跡せず、固定版CLIからlocal bootstrapとCIで生成する。quality gateはformat、lint、knip、typecheck、testとし、実装完了時にlocal Docker buildも行う。build jobは通常CI gateへ加えず、image publishでamd64/arm64 buildを行う。

## 17. Composition and cutover

新module群は旧実装の隣に構築するが、runtime互換layerやdual-writeを作らない。移行中もproduction composition rootは旧か新のどちらか一方だけを指す。

実装順は次とする。

1. shared primitives、strict config、workspace initializer。
2. Discord domain/action/read adapters。
3. Codex process、JSON-RPC、thread/turn adapter。
4. agent turn chainとDiscord MCP。
5. conversation state machineとGateway intake。
6. heartbeat、schedule、retention cleaner。
7. observability、composition integration、Docker。
8. composition rootを一度だけ新実装へ切り替える。
9. 旧source、旧test、旧dependency、旧documentを削除する。

各段階は一目的の署名付きConventional Commitとする。切替前に新しいfake composition testを通し、切替後に全quality gateとlocal Docker buildを再実行する。
