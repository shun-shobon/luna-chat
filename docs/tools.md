# ツール

エージェントのセッションに渡すツールと、ツールの実行に共通する振る舞い（一時ディレクトリ、バックグラウンド実行、待機）を定める。機能固有のツールの入出力は、各機能のファイルにある。

## ツールの一覧

エージェントのセッションを開くとき、実行の種類に応じたツールを渡す。ツールは呼び出された時点で実行し、結果（失敗時はエラーの内容）をそのままエージェントへ返す。同じ応答で呼ばれた複数のツールは並行して実行する。入力スキーマに合わない呼び出しは、検証エラーをツールの失敗として返す。

| ツール                                                                                                                                     | 内容                                                                                                                    | 会話・イベント | 作業エージェント |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------- |
| `exec_command` / `write_stdin`                                                                                                             | シェルコマンドの実行。終わらないコマンドはセッションIDを返し、`write_stdin` で入力と出力の取得を続ける（PTYは使わない） | ◯              | ◯                |
| `stop_background`                                                                                                                          | バックグラウンド実行を止める                                                                                            | ◯              | ◯                |
| `read` / `edit` / `write`                                                                                                                  | ワークスペースのファイルの読み書き                                                                                      | ◯              | ◯                |
| `view_image`                                                                                                                               | 画像ファイルを読み、必要なら縮小してエージェントへ渡す                                                                  | ◯              | ◯                |
| `web_run`                                                                                                                                  | Web検索・ページの閲覧（ChatGPTのバックエンドを使う）                                                                    | ◯              | ◯                |
| `image_gen`                                                                                                                                | 画像の生成・編集。結果を一時ディレクトリへ保存する                                                                      | ◯              | ◯                |
| `read_message_history` / `list_channels` / `get_user_detail` / `list_guild_emojis` / `get_guild_emoji`                                     | Discordの読み取り                                                                                                       | ◯              | ◯                |
| `send_message` / `reply_message` / `edit_message` / `delete_message` / `add_reaction` / `remove_reaction` / `start_typing` / `stop_typing` | Discordへの書き込み（[discord.md](./discord.md)）                                                                       | ◯              | ×                |
| `open_conversation`                                                                                                                        | 指定スコープへ背景情報を渡して会話を委譲                                                                                | ◯              | ×                |
| `task_create` / `task_message` / `task_cancel`                                                                                             | バックグラウンドタスクの依頼・追加指示・取消（[tasks.md](./tasks.md)）                                                  | ◯              | ×                |
| `task_report`                                                                                                                              | 作業エージェントからの報告                                                                                              | ×              | ◯                |
| `http_respond`                                                                                                                             | HTTPの完了待ちリクエストへの応答（[http-api.md](./http-api.md)）                                                        | ◯              | ×                |
| `wait`                                                                                                                                     | 指定秒数の待機                                                                                                          | ◯              | ◯                |
| `ha_list_entities` / `ha_get_state` / `ha_list_services` / `ha_call_service`                                                               | Home Assistantの状態の取得と操作（[home-assistant.md](./home-assistant.md)）。HAの接続を設定した場合のみ                | ◯              | ◯                |
| `assist_respond`                                                                                                                           | Assistへの返答                                                                                                          | ◯              | ×                |
| `voice_join` / `voice_leave` / `voice_report`                                                                                              | ボイスチャンネルへの参加・退出、音声モードの依頼の結果の報告（[voice.md](./voice.md)）。`[voice]` を設定した場合のみ    | ◯              | ×                |

ツールの引数に `.agents/skills/<名前>/SKILL.md` のパスが含まれる `read` と `exec_command` の呼び出しを、そのskillの使用として `LUNA_HOME/state/skill-usage.json`（skill名ごとの最終使用時刻と回数）に記録する。日次整理が使われていないskillを見つけるのに使う。

## 一時ディレクトリ

エージェントのセッションを開くたびに、OSの一時ディレクトリ（Node.jsの `os.tmpdir()`）の下に `luna/<セッションID>/` を作る。エージェントは試行環境・途中のコピー・ダウンロードした素材をここに作り、残したいものをワークスペースへ移す。

- パスはシステムプロンプトの末尾で伝える。
- シェルツールの子プロセスには、このパスを `TMPDIR` として渡す。
- `image_gen` の結果は `generated_images/`、バックグラウンド実行の出力は `background/` に保存する。
- Lunaは一時ディレクトリを削除しない。セッションを閉じた後も残り、消すのはOSの一時ファイルの掃除（systemd-tmpfiles の定期削除や起動時の削除など）に任せる。

## バックグラウンド実行

`exec_command` に `run_in_background: true` を指定すると、コマンドを起動してすぐ `{ id, output_path }` を返し、実行の終了を待たずに動かし続ける。

- `timeout_seconds`（1以上7200以下の整数、既定1800）で上限時間を指定できる。`run_in_background` なしの `timeout_seconds` と、`run_in_background` と `tty`・`yield_time_ms`・`max_output_tokens` の組み合わせはツールの失敗とする。
- stdinを閉じて起動し、標準出力と標準エラー出力を `output_path`（一時ディレクトリの `background/<id>.log`）に書き出す。同時に動かせる数に上限は設けない。
- 上限時間を過ぎたら、プロセスグループへSIGTERMを送り、2秒後に残っていればSIGKILLを送る。
- コマンドが終了したら、プロセスグループに残った子孫も同じ手順で止めてから、同じセッションへ `background_exit` を渡す。実行中なら割り込み入力として同じ実行へ入り、実行していなければ次の実行の入力の前に入る。
- `stop_background`（`{ id: string }`）は、そのプロセスグループを同じ手順で止める。動いていないIDはツールの失敗とする。
- `stop_background` で止めたもの、セッションを閉じる時に止めたもの、シャットダウンで止めたものには `background_exit` を渡さない。セッションを閉じると、残っているバックグラウンド実行を止める。再起動をまたいで再開はしない。

```ts
type BackgroundExit = {
	id: string;
	command: string;
	reason: "exited" | "timed_out";
	exit_code: number; // シグナルで終了した場合は 128 + シグナル番号
	started_at: string;
	ended_at: string;
	output_path: string;
	output_tail: string; // 出力の末尾8KiB
};
```

バックグラウンド実行が残っている間は、セッションを閉じずに完了を待つ。

- 会話: アイドル時間を計測しない。
- イベント実行: 実行が終わってもバックグラウンド実行が残っていれば、`background_exit` を受けて同じセッションで実行を続け（入力の最後に `task_board` を付ける）、残りがなくなってからセッションを閉じる。HTTPの完了待ちの応答は、このような続きの実行を待たない。
- 作業エージェント: [tasks.md](./tasks.md) の状態遷移のとおり。

## 待機

`wait` は `{ duration_seconds: number }` を指定して指定秒数待機し、同じ実行の中で続ける。`duration_seconds` は1以上 `2147483` 以下の整数とする。待機中に届いた入力は待機の後に入る。実行の中断（バックグラウンドタスクの取消・停止）で打ち切られ、ツールの失敗として扱われる。

## 内部設計

### 実行とツールのオーケストレーション

```text
検証済み入力
     │
     ├─ セッションを開く: OpenAgentSession(origin, model?)
     │     ├─ システムプロンプト = 種類ごとの開発者指示 + skill一覧 + LUNA.md + MEMORY.md（作業エージェントは後ろ2つを除く）
     │     ├─ モデル = 渡されたモデル、なければ種類ごとの設定（作業エージェントは設定を持たず、タスクに保存したモデルを必ず渡す）
     │     └─ ツール = ToolSet.bind({ ownerId, origin }) + 汎用ツール
     │
     ├─ run([種類付きメッセージ…])
     │     ├─ モデルがツールを呼ぶ → その場で実行して結果を返す（同じ応答の呼び出しは並行）
     │     ├─ 実行中の入力は steer で次のリクエストの前に入る
     │     └─ 一時的な失敗は同じセッションの続きから再実行（アダプター内）
     │
     ├─ ToolSet.release(ownerId)  # タイピングと待機の解放
     │
     ├─ waitForBackground()  # バックグラウンド実行が残っていれば、通知が届くまで待って同じセッションで続ける
     │
     └─ 完了 / 失敗 / 中断を実行元へ返す
```

- 実行元（`ToolOrigin`: 会話セッション、イベント、タスク）と `ownerId` はセッションを開くときにツールへ束ねる。`task_create` や `task_report` は、エージェントの入力ではなくこの実行元で依頼元・報告元を決める。
- `defineTool` はzodの入力スキーマで1回だけ検証し、パラメータのJSON Schemaは `z.toJSONSchema` で作る。ツール名は集合の中で一意でなければならない。
- ツールの失敗（検証エラー・例外）は `isError` の結果としてエージェントへ返し、実行は止めない。成功と失敗は `tool.succeeded`・`tool.failed` としてログに残す。
- 汎用ツール（シェル、`read`/`edit`/`write`、`view_image`、`web_run`、`image_gen`）は、エージェントのアダプターが `spec.harnessTools` に応じて作る。
- 一時ディレクトリのパスは、システムプロンプトを組み立てる `session-factory` ではなくアダプターが書き足す。セッションIDがアダプターの中で決まるため。
- skillの使用記録は `read` と `exec_command` を包んで取る。記録の失敗はログに残してツールの実行は止めない。

### バックグラウンド実行

```text
exec_command(run_in_background) ─► シェルツールのバックグラウンド実行の表（セッションごと）
                                         │ 終了（通知あり）       │ stop_background / stopBackground / dispose（通知なし）
                                         ▼                        ▼
                         PiAgentSession.onBackgroundExit    PiAgentSession.onBackgroundStopped
                           ├ 実行中: steer                      └ 残りも通知もなければ待ちを false で解く
                           └ 実行外: pending に積み、待ちを true で解く ─► 次の run の入力の前に入れる
```

- `AgentSession` は `hasBackground()`・`waitForBackground()`・`stopBackground()` を持つ。`waitForBackground()` は、届いた通知があれば `true`、通知なしにすべて止まった（または初めから何もない）なら `false` で解決する。届いた通知は次の `run` の入力の前に入るため、持ち主は `run([])` で続けられる。
- `stopBackground()` は、まだ `run` に入れていない通知も捨てる。記憶保存やシャットダウンの直前に届いた通知を、`session_end` の実行に混ぜないため。
- 実行中かどうかの判定はアダプターが持つ。`run` の完了から持ち主の継続までの間に届いた通知を、持ち主ではなくアダプターが `pending` に積むため、取りこぼしが起きない。
- プロセスの出力は Node のパイプを通さずログファイルへ直接書かせる。長時間動くプロセスの出力をメモリに溜めないため。
- 持ち主ごとの続け方: 会話アクターは `IDLE` で待つ（[ARCHITECTURE.md](./ARCHITECTURE.md) の会話セッションの状態遷移）。EventExecutor は実行のたびに `waitForBackground()` を待ち、`true` なら `run([task_board])` を続ける。TaskService は終了報告がなければ、`waitForBackground()` とメッセージの到着を待つ。
- シャットダウンでは EventExecutor の `stopBackground()` が実行中のすべてのセッションの `stopBackground()` を呼び、以後の待ちをしない。会話は記憶保存の前、タスクは中断で止める。
