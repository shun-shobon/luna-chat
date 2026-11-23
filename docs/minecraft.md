# Minecraft

`config.toml` に `[minecraft]` と `[models.minecraft]`（[SPEC.md](./SPEC.md) の設定）を書くと、ルナがMinecraft Java Editionのサーバーにプレイヤーとして入り、遊べる。`[minecraft]` がなければ、この文書のツールと `minecraft` の作業エージェントは使わない。

## 設定

```toml
[minecraft]
host = "127.0.0.1"
port = 25565
username = "Luna"
world = "trial-1"
decision_model = "typesafe/jev"
decision_timeout_ms = 3000
planner_interval_ms = 60000
```

- `decision_timeout_ms`・`planner_interval_ms`（いずれも1以上の整数）は省略すると上の値になり、それ以外は必須とする。`host` は接続先のホスト名かIPアドレス、`port` は1〜65535、`username` はオフラインモードで名乗るプレイヤー名（3〜16文字の英数字と `_`）、`world` は[ワールドの記憶](#ワールドの記憶)を分ける名前（`[models.worker]` の選択肢の名前と同じ規則）とする。サーバーのワールドを入れ替えたら `world` も変える。`decision_model` は `[voice].interrupt_model`（[voice.md](./voice.md)）と同じ規則の決定モデルで、[1手の判断](#1手の判断)に使う。
- 計画役のモデルは `[models.minecraft]`（[SPEC.md](./SPEC.md) の設定）で選ぶ。

## 構成

計画役の応答には数秒から数十秒かかり、その間もゲームの時間は進む。そのため、計画役を待たずに動ける層を下に置き、速さの違う3つの層で遊ぶ。

| 層        | 担い手                                           | 間隔                                     | 役割                                                                                                         |
| --------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 反射      | Lunaのコード                                     | 毎tick（50ms）                           | 命の危険から逃げる（[反射](#反射)）。下の2層を待たない                                                       |
| 1手の判断 | 決定モデル（`decision_model`）                   | 1行動ごと                                | 観測と目標から、行動の候補を1つ選び、目標の状態を答える（[1手の判断](#1手の判断)）                           |
| 計画      | `minecraft` の作業エージェント（以下「計画役」） | 出来事ごと、および `planner_interval_ms` | 目標を決め、出来事を受けて立て直し、依頼元へ報告する（[計画役のツール](#計画役のツール)、[出来事](#出来事)） |

- サーバーはLunaの外で動かす。Lunaは `host:port` へオフラインモードで接続するだけで、サーバーの起動・停止、ワールドの入れ替え、権限の付与は行わない。版はサーバーから取得し、Mineflayerが対応しない版は接続の失敗とする。
- プレイは同時に1つだけとし、`minecraft` のタスク（[tasks.md](./tasks.md)）が持つ。
- 依頼元への伝達は `task_report`、依頼元からの指示は `task_message` で行う（[tasks.md](./tasks.md)）。ゲーム内のチャットは送りも受け取りもしない。

## 接続とプレイの期間

- プレイは、計画役がそのセッションで初めて[計画役のツール](#計画役のツール)を呼んだ時点で、サーバーに接続して始まる。接続できなければ、そのツールの失敗とする。
- プレイ中に切断されたら、`disconnected` の[出来事](#出来事)を渡し、5秒・10秒・30秒・60秒（以後60秒）待って再接続を続ける。切断中は判断も反射も止まり、再接続したら前の目標で続ける。
- 死んだら自動で復活し、`death` の出来事を渡す。目標は消さない。
- タスクのセッションを閉じる時（終了報告、取消、シャットダウン）に、押している入力を離してから切断し、プレイを終える。

## 観測

決定モデルと計画役には、次の観測（`MinecraftObservation`）を渡す。サーバーから受け取ったデータのうち、ルナの目から見えるものと、過去に見て覚えたもの（[ワールドの記憶](#ワールドの記憶)）だけを入れる。壁越しや地中のブロック・エンティティは、受け取っていても入れない。

対象が**見える**とは、目の位置から対象の点（ブロックは中心と各面の中心、エンティティは当たり判定の中心と頭）のいずれかへの線分が不透明なブロックに遮られず、その点まで32ブロック以内であることをいう。

```ts
type Vec3 = { x: number; y: number; z: number };
type MinecraftObservation = {
	self: {
		position: Vec3;
		dimension: string;
		health: number; // 0〜20
		food: number; // 0〜20
		oxygen: number; // 0〜20
		held: string | null;
		armor: string[];
		effects: string[];
		on_ground: boolean;
		in_water: boolean;
		in_lava: boolean;
		burning: boolean;
	};
	inventory: Record<string, number>; // アイテム名ごとの数
	world: { time_of_day: number; raining: boolean; thundering: boolean };
	goal: { objective: string; targets: Record<string, number>; waypoint: Vec3 | null } | null; // 「計画役のツール」 の minecraft_goal で置いた目標。場所の名前は位置にして持つ
	visible_entities: {
		id: number;
		name: string;
		kind: "hostile" | "passive" | "player" | "item" | "other";
		position: Vec3;
		distance: number;
	}[]; // 近い順に最大16件
	visible_blocks: { name: string; position: Vec3; distance: number }[]; // 対象の種類ごとに近い順に最大3件
	places: {
		name: string | null;
		kind: string;
		position: Vec3;
		dimension: string;
		distance: number;
	}[]; // 覚えている場所と鉱石。近い順に最大16件
	recent_actions: {
		action: string;
		result: "succeeded" | "failed" | "interrupted";
		detail: string;
		at: string;
	}[]; // 直近5件
	last_reflex: { trigger: string; at: string } | null;
};
```

- `visible_blocks` の対象は、原木・石・砂・砂利・鉱石・作業台・かまど・チェスト・ベッド・水・溶岩と、目標の `targets` にあるアイテムを落とすブロックとする。
- `minecraft_observe`（[計画役のツール](#計画役のツール)）は、これに目標の状態（[1手の判断](#1手の判断)の直近の答え）と直近の出来事を足して返す。

## 1手の判断

目標があり、反射が動いていない間、1行動ずつ次を繰り返す。目標がない間と、目標の状態を `goal_done` か `goal_stuck` で通知した後は、新しい目標が来るまで判断しない（反射は動く）。

1. 観測を作る。目標の `targets` がある時に持ち物がすべて満たしていたら、決定モデルに尋ねずに `goal_done` を通知する。
2. 今できる行動の候補を下の表から列挙する。種類ごとに近い順に数を絞り、合計を255件以内にする。
3. `decision_model` に、観測を `state` として、2つの質問を1回のリクエストで送る。`action` は候補から1つを選ぶ質問、`goal` は目標が `done`（達成した）・`in_progress`（進んでいる）・`stuck`（行き詰まった）のどれかを選ぶ質問とする。タイムアウトは `decision_timeout_ms` で、再試行しない。
4. 答えを待つ間に、位置が1ブロック以上動いた、体力が減った、16ブロック以内に新しい敵が見えた、のいずれかが起きたら、答えを捨てて1に戻る。
5. 選ばれた行動を実行する。実行中に被弾するか、16ブロック以内に新しい敵が見えたら、行動を止めて（結果は `interrupted`）1に戻る。行動を始めた時に見えていた敵は新しい敵に数えない。
6. 結果を `recent_actions` に入れる。

| 行動             | 候補の対象                                                                                  | 上限時間 |
| ---------------- | ------------------------------------------------------------------------------------------- | -------- |
| `move_to`        | 覚えている場所、目標の `waypoint`                                                           | 60秒     |
| `explore`        | 東西南北それぞれ32ブロック先                                                                | 60秒     |
| `mine`           | 見えていて、今の持ち物で掘ってアイテムを落とせるブロック                                    | 30秒     |
| `collect`        | 見えている、落ちたアイテム                                                                  | 30秒     |
| `craft`          | 今の持ち物と、4ブロック以内の作業台で作れるレシピ（1回分）                                  | 10秒     |
| `place`          | 持っている作業台・かまど・チェスト・松明・ベッドを、そばに置く                              | 10秒     |
| `dig_down`       | 足元のブロック（今の持ち物で掘れて、その下が溶岩などでない）                                | 15秒     |
| `dig_stair`      | 東西南北それぞれ、階段状に1段掘り下げた先                                                   | 30秒     |
| `tunnel`         | 東西南北それぞれ、体と頭の高さの2マスを掘った先                                             | 20秒     |
| `place_block`    | 持っている土・丸石・板材など（3種類まで）を、頭上・足元（跳んで真下へ）・東西南北の隣に置く | 10秒     |
| `smelt`          | 4ブロック以内のかまどへの材料・燃料の投入、できた物の取り出し                               | 10秒     |
| `store` / `take` | 4ブロック以内のチェストへの預け入れ・取り出し                                               | 10秒     |
| `equip` / `eat`  | 持っている道具・防具・食料                                                                  | 10秒     |
| `sleep`          | 4ブロック以内のベッド（夜だけ）                                                             | 10秒     |
| `attack`         | 見えている敵・動物                                                                          | 15秒     |
| `retreat`        | 見えている敵から離れる                                                                      | 15秒     |
| `wait`           | 2秒待つ                                                                                     | 5秒      |

- 経路はMineflayerの経路探索に任せる。3ブロックを超える落下（水への落下を含む）と、溶岩・火を通る経路は使わない。水の中ではジャンプを押し続けて水面に浮かせる（泳いで渡るのはよい）。移動のためのブロックの掘削と、持っている土・丸石の設置はしてよい。経路が見つからない移動は失敗とする。
- `dig_down`・`dig_stair`・`tunnel`・`place_block` は、触れている隣のブロックだけを扱う。できるかどうか（今の持ち物で掘れるか、立つ先の床が溶岩などでないか、掘る先が水や溶岩でないか、置く先の隣に支えになるブロックがあるか）はワーカーが確かめ、できるものだけを候補にする。
- 次のどちらかで、目標の状態を計画役へ通知する（[出来事](#出来事)）。
  - `goal_done`: 手順1で持ち物が `targets` を満たしていた。または、`goal` の答えが確率0.8以上の `done` で、それが2回続いた。
  - `goal_stuck`: `goal` の答えが確率0.8以上の `stuck` で、それが3回続いた。または、行動の失敗（決定モデルの失敗とタイムアウトを含む）が3回続いた。手順4の理由で答えを3回続けて捨てたら、行動の失敗1回と数える。

## 反射

毎tick次の危険を確かめ、決定モデルと計画役を待たずに動く。反射の間は1手の判断を止め、実行中の行動を中断する。

| きっかけ                                                            | 動き                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 溶岩に触れている、または燃えている                                  | 溶岩と火のない、立てるブロックのうち最も近いものへ動く。4ブロック以内に水があれば水へ入る |
| 水中で、酸素が10以下                                                | 上へ泳ぎ、水から出るか酸素が満タンに戻るまで浮く                                          |
| 体力が8以下で、敵が見えている                                       | 見えている敵から離れる方向へ走る。16ブロック離れるか、どの敵も見えなくなるまで            |
| 体力が8以下で、敵が見えておらず、満腹度が20未満で、食料を持っている | 食べる                                                                                    |

- きっかけがなくなるか、10秒経ったら終わり、`reflex` の出来事を渡す。終わった時に同じきっかけが続いていれば、もう一度動く。

## 計画役のツール

| ツール                 | 入力                                                                                                          | 結果                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `minecraft_goal`       | `{ objective: string(1〜500文字), targets?: Record<アイテム名, 1以上の整数>, waypoint?: Vec3 \| 場所の名前 }` | `{ accepted_at }`                                                           |
| `minecraft_observe`    | `{}`                                                                                                          | `MinecraftObservation` に、目標の状態と直近の出来事（最大20件）を足したもの |
| `minecraft_name_place` | `{ name: string(1〜64文字), position?: Vec3 }`                                                                | `{ name, position }`                                                        |

- `minecraft_goal` は目標を置き換えてすぐ返る。新しい目標は次の判断から使い、実行中の行動は止めない。`targets` は決定モデルへの手がかりにし、持ち物がすべて満たしたら達成とする（[1手の判断](#1手の判断)）。存在しないアイテム名と、覚えていない場所の名前はツールの失敗とする。
- `minecraft_name_place` は場所に名前を付けて記憶する（[ワールドの記憶](#ワールドの記憶)）。`position` を省略すると今いる位置とする。同じ名前があれば置き換える。
- 計画役の開発者指示は、ふつうの作業エージェントの指示に、give・テレポート・ゲームモードの変更などのコマンドを使わないこと、遊び終えたら結果を `task_report` で報告することを足したものとする。

## 出来事

次の出来事を、計画役のセッションへ `minecraft_event`（[SPEC.md](./SPEC.md) の入力の形式）として渡す。実行中なら割り込み入力として入り、実行していなければタスクの続け方（[tasks.md](./tasks.md) の状態遷移）に従う。

```ts
type MinecraftEvent = {
	type: "goal_done" | "goal_stuck" | "reflex" | "death" | "disconnected" | "interval";
	urgent: boolean; // reflex・death・disconnected で真
	at: string;
	detail: string;
	observation: MinecraftObservation | null; // disconnected では null
};
```

- `death` の `detail` には、死亡のメッセージ、死んだ位置、失った持ち物を書く。
- `interval` は、計画役が最後に[計画役のツール](#計画役のツール)を呼んでから `planner_interval_ms` の間、ほかの出来事を渡していない時に渡す。
- まだ計画役の入力に入っていない出来事に同じ `type` のものがあれば、古いほうを捨てる。

## ワールドの記憶

ルナが見たものを、`world` ごとに `LUNA_HOME/minecraft/<world>/memory.json` に記憶する。一時ファイルからの置き換えで保存する。読めないファイルやスキーマに合わないファイルは、プレイの開始の失敗とする。

- 場所: 見えた作業台・かまど・チェスト・ベッドと、`minecraft_name_place` で名付けた場所。
- 鉱石: 見えた鉱石のブロック。
- チェストの中身: 最後に開けた時の中身と時刻。
- 死亡: 死んだ位置、時刻、メッセージ、失った持ち物。直近20件。

場所と鉱石は、記憶した位置が見えてそこにもうないと分かったら消す。

## ログ

判断ごとにinfoログ `minecraft.decision`（候補の数、選んだ行動、目標の状態とその確率、待ち時間）、行動ごとに `minecraft.action`（行動、結果、かかった時間）、出来事ごとに `minecraft.event` を出す。

## 内部設計

```text
minecraft_goal / minecraft_observe / minecraft_name_place（minecraft の作業エージェントだけに渡す）
        │ ToolExecution（ownerId・origin・activities）
        ▼
MinecraftPlayService ── プレイ（同時に1つ）: 判断のループ・出来事・再接続・interval
   ├─ listCandidates / buildObservation / GoalTracker / rememberSnapshot（domain）
   ├─ DecisionModelPort ◄─ PiDecisionModel（pi-ai の classify）
   ├─ WorldMemoryStorePort ◄─ JsonWorldMemoryStore
   └─ MinecraftConnector ◄─ createMineflayerConnector ── worker_threads のメッセージ ──► minecraft-worker（MineflayerPlayer）
                                                                                         ├ Mineflayer・経路探索
                                                                                         ├ 見える判定と観測の素材（WorldSnapshot）
                                                                                         ├ 行動の実行と、被弾・新しい敵での中断
                                                                                         └ 反射（毎tick）
```

- `MinecraftPlayService`（application）はプレイを1つだけ持つ。最初のツール呼び出しで記憶を読み、接続してから `ToolExecution.activities` で続いている作業（[tools.md](./tools.md)）を始める。作業が止められた時（セッションを閉じる、取消、シャットダウン）の後始末で、判断のループを止めて切断する。プレイ中に別の `ownerId` から呼ばれたらツールの失敗にする。
- 判断のループは、観測、候補の列挙、決定モデル、推論後の観測との比較、行動の実行の順に1手ずつ回す。目標がない間、目標の状態を通知した後、切断中は、新しい目標か再接続で起こされるまで眠る。終わりは別の非同期処理から来るため、await をまたぐ判定はそのたびに読み直す。
- 出来事は作業のハンドルの `notify` で渡し、`replaceKey` に出来事の `type` を使う。計画役がまだ読んでいない同じ種類の出来事を、新しいもので置き換えるため。`interval` のタイマーは、ツールが呼ばれるたびと出来事を渡すたびに仕掛け直す。タイマーはコンストラクタに渡す `schedule` で仕掛け、テストから進められるようにする。
- domain には、外部に触れない規則を置く。観測の組み立て、行動の候補の列挙と255件への絞り込み、判断の答えから出来事を決める規則（確率0.8、連続回数）、反射のきっかけの判定、ワールドの記憶の更新、アイテムの分類。反射のきっかけの判定とアイテムの分類は worker thread からも使う。
- `PiDecisionModel`（adapter）は候補に `a0` から順にキーを振り、説明文を `criteria` にして1つの `choice` の質問にする。目標の状態は別の `choice` の質問として同じリクエストに入れる。答えのキーが候補にない、または `stopReason` が `stop` でない答えは例外にする。`PiInterruptClassifier` と同じく、OpenAI と TypeSafe のプロバイダだけを入れた専用の pi-ai `Models` で `classify` を呼び、作る時にモデルの有無と鍵を確かめる。
- Mineflayer と経路探索は worker_threads で動かす。mineflayer-pathfinder は経路を探す間、1tickあたり最大40ms（`tickTimeout` の既定）イベントループを止めるため、20msごとにフレームを送るVCの再生と同じスレッドに置かない。接続するたびに新しいワーカーを起こし、切断したら止める。反射はワーカーの中で毎tick判定して動き、メインスレッドとの往復を待たない。メインスレッドとは要求と返事（番号で対応づける）、反射・死亡・切断の通知をやりとりし、受け取った側でZodで検証する（`mineflayer-protocol.ts`）。行動の上限時間はメインスレッドが持ち、過ぎたら中断を送ってワーカーの返事を待つ。
- ワーカーの入口は、ビルドでは `dist/minecraft-worker.mjs`（tsdown の2つ目の入口）、tsx で動かす開発時とテストではソースの `.ts` を tsx で読む。`spawnMineflayerWorker` が `import.meta.url` の拡張子で選ぶ。
- Mineflayer の型に載っていない値（`isInWater`・`isInLava`・`eyeHeight`、`world.raycast` が返すブロックの `position`、燃えている印のメタデータ）は、読む時にZodで検証する。prismarine-* は直接の依存にせず、型は Mineflayer の `Bot` から取る。
- ワールドの記憶は、変わった時だけ `SerialQueue` で順に `JsonWorldMemoryStore` へ書く。ストアは一時ファイルからの置き換えで保存する。
- `snapshot` はダッシュボード（[dashboard.md](./dashboard.md)）に、接続状態、目標、直近の行動と出来事、判断の待ち時間を渡す。
