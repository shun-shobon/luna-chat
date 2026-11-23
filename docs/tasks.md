# バックグラウンドタスク

会話やイベント実行（依頼元）が、数分以上かかる調査・制作・多数のツール呼び出しを伴う作業を作業エージェントへ委任する仕組みを定める。依頼元は `task_create` で委任して完了を待たずに実行を終え、結果は通知で受け取る。作業エージェントは `LUNA.md` と `MEMORY.md` を事前に読み込まない別のセッションで作業し、Discordへは投稿しない。依頼元への伝達はすべて `task_report` と通知を介する。

## 依頼元が使うツール

| ツール         | 入力                                                                                 | 結果                                    |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `task_create`  | `{ title: string(1〜120文字), instructions: string(1〜20000文字), worker?: string }` | `{ task_id, worker, status: "queued" }` |
| `task_message` | `{ task_id: string, text: string(1〜8000文字) }`                                     | `{ task_id, status }`                   |
| `task_cancel`  | `{ task_id: string, reason?: string(1〜2000文字) }`                                  | `{ task_id, status: "cancelled" }`      |

- 文字列は前後の空白を除いた長さで検証する。制約を満たさない入力はツールの失敗となる。
- `task_create` の `worker` は `[models.worker]`（[SPEC.md](./SPEC.md) の設定）の選択肢の名前で、省略すると `default` になる。選択肢にない名前はツールの失敗とする。`task_create` の説明には、選択肢ごとの名前と `description`、どれが既定かを並べる。選んだモデルと推論強度はタスクに保存し、そのタスクの実行（再起動後の再開を含む）はすべてそれを使う。後から設定を変えても、作成済みのタスクのモデルは変わらない。設定から選択肢を消すと、その名前のタスクは実行を始める時に失敗とする。
- `task_message` と `task_cancel` は、依頼元から見えるタスクで、かつ終了していないものだけに使える。それ以外はツールの失敗とする。
- `[minecraft]` を設定すると、`worker` の選択肢に `minecraft` が加わる（[minecraft.md](./minecraft.md)・未実装）。`task_create` の説明には `[models.minecraft]` の `description` を並べる。この種類のタスクは `[models.minecraft]` のモデルと推論強度を使い、Minecraftのツールを持つ。終了していない `minecraft` のタスクがあるときに `minecraft` を選ぶと、ツールの失敗とする。
- 作業エージェントは `task_create` を使えない。

## 作業エージェントの入力とツール

作業エージェントのツールは、[tools.md](./tools.md) の表で「作業エージェント」が◯のもの（Minecraftの種類は△のものも）とする。入力は次の種類のメッセージで渡す。

```ts
type TaskAssignment = {
	// kind: "task_assignment"
	id: string;
	title: string;
	instructions: string;
	origin: string; // 依頼元の会話セッションキーまたはイベント種別
	created_at: string;
	attempt: number; // 1から始まる実行回数
	previous_reports: TaskReportJson[];
	messages: TaskMessageJson[]; // これまでの全メッセージ
};
type TaskMessages = { task_id: string; messages: TaskMessageJson[] }; // kind: "task_message"
type TaskCheck = { task_id: string }; // kind: "task_check"

type TaskReportJson = {
	seq: number;
	kind: TaskReportKind;
	summary: string;
	artifacts: string[];
	reported_at: string;
};
type TaskMessageJson = { id: string; text: string; received_at: string };
```

`task_report` の入力は `{ kind, summary: string(1〜4000文字), artifacts?: 絶対パスの配列 }` とし、`kind` は次のとおり。

| `kind`      | 状態への影響    | 依頼元への通知                 |
| ----------- | --------------- | ------------------------------ |
| `progress`  | 変化なし        | しない（タスク一覧にのみ反映） |
| `milestone` | 変化なし        | する                           |
| `question`  | `waiting_input` | する                           |
| `result`    | `completed`     | する                           |
| `failure`   | `failed`        | する                           |

## 状態遷移と実行

```text
queued ──(実行枠が空く)──► running ──result──► completed
  ▲                          │  └─failure / 実行失敗──► failed
  │                          │question
  │                          ▼
  └──(message受信)──── waiting_input
任意の未終了状態 ──task.cancel──► cancelled
```

- 同時に `running` にできるタスクは `[tasks].max_concurrent`（デフォルト2）件までとし、超えたタスクは作成順に待機する。`waiting_input` は実行枠を使わない。`minecraft` のタスク（[minecraft.md](./minecraft.md)・未実装）は実行枠を使わず、`queued` からすぐに始める。
- `queued` から実行を始めるたびに `attempts` を1増やし、新しいセッションで `task_assignment` を渡す。`attempts` が5を超えた場合は実行せず失敗とする。
- 実行が終わった時点で未配送のメッセージがあれば、同じセッションで `task_message` を渡して続行する（状態は `running` に戻る）。
- 終了報告（`result`・`failure`・`question`）がないまま実行が終わり、バックグラウンド実行が残っている場合は、`running` のまま（実行枠を使ったまま）待つ。`background_exit` かメッセージが届いたら、同じセッションで実行を続ける。
- Minecraftのプレイ（[minecraft.md](./minecraft.md)・未実装）も続いている作業として同じく扱う。終了報告がないまま実行が終わり、プレイが続いていれば `running` のまま待ち、`minecraft_event` が届いたら同じセッションで実行を続ける。`question` で待機している間もプレイは今の目標のまま続き、急ぎの出来事が届いた時だけ同じセッションで再開する（状態は `running` に戻る）。急ぎでない出来事は、再開した実行の入力の前に入る。
- 終了報告がなく、バックグラウンド実行も残っていない場合は、一度だけ `task_check` を渡す。再び終了報告がなければ失敗とする。
- `question` で待機したセッションは同じプロセス内で保持し、メッセージ受信時に同じセッションで `task_message` を渡して再開する。そのセッションのバックグラウンド実行は動き続け、待機中に終わったものの `background_exit` は再開した実行の入力の前に入る。プロセスの再起動で保持が失われた場合は、新しいセッションで `task_assignment` から再開する。
- 実行の一時的な失敗は [agent.md](./agent.md) のとおり再実行する。それ以外の実行の失敗・中断は、タスクの失敗とする。
- 実行中のタスクへのメッセージは、割り込み入力として同じ実行へ渡す。
- `task_cancel` は実行を中断してバックグラウンド実行を止め、以後の実行を開始しない。実行済みの外部作用は取り消さない。
- 終了したタスクのセッションは閉じる（残っているバックグラウンド実行も止まり、Minecraftのプレイも終わる）。

## 公開範囲とタスク一覧

- Discordのギルドチャンネルまたはギルドスレッドの会話から作成したタスクは、すべての会話から見える。DM・HTTP会話・イベント実行から作成したタスクは非公開とし、作成した会話とイベント実行からだけ見える。イベント実行からはすべてのタスクが見える。
- 会話とイベントの各実行の開始時に渡す `task_board` には、見えるタスクのうち未終了のもの、および終了から24時間以内のものを、更新が新しい順に最大20件含める。

```ts
type TaskSummary = {
	id: string;
	title: string;
	worker: string; // 選んだ作業エージェントの名前
	status: "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";
	origin: string;
	created_at: string;
	updated_at: string;
	latest_report: { kind: TaskReportKind; summary: string; reported_at: string } | null;
	undelivered_messages: number;
};
```

## 依頼元への通知

通知する報告は `luna.task.reported.v1` イベント（`source: "luna/task"`、`subject` はタスクID、`data` は `{ task: TaskSummary, instructions: string, report: TaskReportJson }`）として依頼元へ届ける。`instructions` は依頼時の指示で、結果を受け取る実行が新しいセッションでも、結果をどう扱うかが分かるようにする。

- 依頼元が会話の場合は、その会話セッションへ通常の受付イベントとして渡す。セッションが終了していれば新しいセッションで受け付ける。
- 依頼元がイベント実行の場合は、新しいワンショット実行として渡す。実行を始めた時点で配送済みとし、その実行が失敗しても再配送しない。シャットダウン時はこの実行の完了を待つ。
- シャットダウン開始後の通知と、受付停止中の会話へ渡せなかった通知は未配送として残し、次回起動時に配送し直す。会話へ受け付けた後にプロセスが終了した場合の再配送は行わない。
- ランタイム起因の失敗（試行回数超過、最終報告なし、実行の失敗など）は、`failure` の報告として記録し通知する。

## 永続化と再起動

- タスクは `LUNA_HOME/tasks/<task_id>.json` に1件1ファイルで保存し、一時ファイルからの置き換えで更新する。読み込めないファイルやスキーマに合わないファイル（作業エージェントのモデルを持たない `version: 1` のファイルを含む）はエラーログを記録して読み飛ばす。
- 起動時に `running` だったタスクは `queued` に戻して再開する（`attempts` は再開時に増える）。作業エージェントには、前回の試行が中断されたことを `attempt` と `previous_reports` で伝え、外部作用のやり直し前に確認させる。
- シャットダウン時は実行中のタスクを `queued` に戻し、実行を中断して `wait` を打ち切る。中断した実行の終了、セッションを閉じること、状態の保存を待ってから終了する。`question` で待機中のセッションも閉じる。
- Minecraftのプレイ（[minecraft.md](./minecraft.md)・未実装）は、セッションを閉じる時にサーバーから切断して終わる。再開した `minecraft` のタスクでは、計画役がMinecraftのツールを呼んだ時点でプレイを始め直す。

## 内部設計

```text
依頼元(会話/イベント) ──task_create──► TaskService ──queue──► 作業セッション(OpenAgentSession)
        ▲                                 │  run(task_assignment) ─► task_report ツール
        │ luna.task.reported.v1           │  steer(task_message)
        └──── TaskDeliveryPort ◄──────────┘  abort(cancel / shutdown)
```

- `TaskService` はタスクをメモリ上の `Map` で保持し、更新のたびにタスクごとに直列化した書き込みで `TaskStorePort` へ保存する。`question` で待機したセッションはプロセス内の `parked` 表に保持する。
- 作業セッションのツール集合は、Discordの読み取り、`task_report`、`wait` で構成する（汎用ツールはアダプターが加える）。
- 通知は `TaskDeliveryPort` を介して、会話には `ConversationCoordinator.accept`、イベント起点にはEventExecutorの新規実行として渡す。配送の受理時刻を報告に記録し、未受理の通知は起動時に再配送する。
- 会話とイベントの入力に同梱するタスク一覧は、`ConversationTaskBoardPort` / `EventTaskBoardPort` を介して `TaskService.listFor` から取得する。conversation・eventモジュールをtaskモジュールに依存させないため。
- 作業エージェントの選択肢（`WorkerChoice`）は、モデルと推論強度に加えて `exclusive` を持つ。`exclusive` の選択肢のタスクは共有の実行枠を使わず、終了していないものを同時に1件までとする。`TaskService` は実行を始めるたびに選択肢をタスクの `worker.name` で引き、見つからなければ失敗にする。
- 作業セッションは `{ kind: "task", taskId, worker }` の実行元で開く。セッションファクトリは `worker`（選択肢の名前）からプロファイル（ツール集合と開発者指示）を選ぶ。どの名前にどのプロファイルを使うかはコンポジションルートが決めるため、task モジュールは個々の種類を知らない（未実装（[minecraft.md](./minecraft.md)）: `minecraft` の選択肢とプロファイル）。
- `question` で保持したセッションは `waitForActivity("urgent")` を待ち、急ぎの通知が届いたらタスクを `queued` に戻す。再開した実行は、未配送のメッセージがあれば `task_message`、なければ空の入力（保留中の通知だけ）で続ける。
- 取消・シャットダウンでは、作業セッションの `ownerId` で `ToolSet.release` を呼んで `wait` を打ち切り、セッションを `abort` してバックグラウンド実行を止める。
