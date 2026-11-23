# オートメーション

人の入力を待たずにエージェントを動かす仕組み（ハートビート、日次整理、スケジュール実行）と、話題をきっかけにする予定を定める。ハートビート・日次整理・スケジュールは、どれもイベント実行として新しいセッションで1回実行し、完了後（バックグラウンド実行が残っていれば、その続きの実行も終わった後）にセッションを閉じる。各実行でエージェントが何をするかは開発者指示にある。

## ハートビート

ルナの定期確認と自由時間である。前回のハートビート完了後、`min_interval_ms` から `max_interval_ms` の間でランダムに決定された間隔を経て次回が実行される。

実行時は `HEARTBEAT.md` と `AGENDA.md` を読み込み、`system.heartbeat.fired.v1`（`data` は `{ checklist, agenda }`）として実行する。どちらかが読めない場合はその回を実行せずエラーログを記録し、次回を予約する。

## 日次整理

`[memory].enabled = true` の場合、`maintenance_cron` のスケジュールで `memory_maintenance` 入力を渡して実行する。エージェントは日次記憶を `MEMORY.md` と `memory/topics/` へ整理し、使われていないskillのアーカイブ、ワークスペースの不要なファイルのゴミ箱への移動、`AGENDA.md` の見直しを行い、Gitが使えればワークスペースをローカルにコミットする。

## スケジュール実行

`LUNA_HOME/workspace/cron.toml` に記述されたジョブを実行する。設定ファイルは自動監視され、再起動なしで変更が反映される。

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

各ジョブは発火時刻に `system.schedule.fired.v1` イベント（`data` は `{ jobId, prompt, kind }`）として実行される。ワンショットジョブ（`kind = "one_shot"`）は、実行開始直後に設定ファイルから自動的に削除される。

定期ジョブ（`kind = "recurring"`）は、同じジョブの前回の実行（checkを含む）が完了していなくても、次の発火時刻に前回を待たず独立して実行される。重複実行は抑止しない。発火後に `cron.toml` が変更・削除されても、発火済みの実行は発火時点の定義で最後まで続く。

### 事前判定コマンド

定期ジョブには任意の `check`（空白のみでない文字列）を指定でき、発火のたびにエージェントを起動するかをシェルコマンドで事前判定できる。ワンショットジョブに `check` を指定した `cron.toml` は不正として扱う。

```toml
[[jobs]]
id = "release-watch"
enabled = true
kind = "recurring"
cron = "*/30 * * * *"
check = "./scripts/check-release.sh"
prompt = "data.check_output にある新しいリリースを要約し、Discordチャンネル(ID: 1234567890)へ報告する"
```

- 発火時、エージェントを起動する前に、ワークスペースディレクトリをカレントディレクトリとして `/bin/sh -c <check>` を実行する。
- 環境変数はLunaプロセスのものから、子プロセスに渡さない鍵（[SPEC.md](./SPEC.md) の環境変数）を除いて渡す。標準入力は閉じた状態とし、読み取りは即座にEOFとなる。
- タイムアウトは120秒固定とする。超過した場合はcheckのプロセスグループへSIGTERMを送り、5秒後もなお終了していなければSIGKILLを送って、失敗として扱う。

| checkの結果                                         | 挙動                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 終了コード0、前後の空白を除いた標準出力が空でない   | `system.schedule.fired.v1` を実行する。`data` に前後の空白を除いた標準出力を `check_output` として加える。32000文字を超える場合は先頭32000文字に切り詰め、`check_output_truncated: true` を加える（超えなければこのフィールドは付けない）。 |
| 終了コード0、前後の空白を除いた標準出力が空         | エージェントを起動しない。infoログ `automation.schedule.check_skipped` を記録する。                                                                                                                                                         |
| 非0終了、シグナルによる終了、タイムアウト、起動失敗 | エージェントを起動しない。errorログ `automation.schedule.check_failed` に終了コード・シグナル・タイムアウト有無・エラーを記録する。標準エラー出力の末尾2000文字は `LOG_LEVEL=debug` または `trace` のときのみ出力する。                     |

`check` の追加・変更・削除はジョブ定義の変更として扱い、ジョブを再登録する。`occurredAt` はcheckの完了時刻ではなく発火時刻とする。

## 話題をきっかけにする予定

「誰かが旅行の話をしたら感想を聞く」のように、時刻ではなく話題をきっかけにする予定を、ワークスペースの `intents.toml` に書く。エージェントが自分で編集する。ファイルがなければ予定はない。

```toml
[[intents]]
id = "ask-trip"
keywords = ["旅行", "北海道"]
action = "旅行の感想を聞く"
expires_at = "2026-12-01T00:00:00+09:00"
cooldown_hours = 24 # 省略時24
max_fires = 3 # 省略時3
```

- `id` は一意、`keywords` は1つ以上、`action` は空でない文字列、`expires_at` はオフセット付きISO 8601とする。不正なファイルはエラーログを記録し、予定がないものとして扱う。
- 会話セッションが受け付けた人（author が human）のDiscordメッセージの本文に、キーワードのいずれかがNFKC正規化と小文字化の上で含まれ、期限前で、発火回数が `max_fires` 未満で、前回の発火から `cooldown_hours` 以上経っていれば発火する。
- 発火すると、その会話へ `intent` 入力（`{ id, action, keyword, messageId, firesRemaining }`）を、該当メッセージの直後（実行の開始時はタスク一覧の前、実行中は割り込み入力で）に渡す。発火回数と時刻は `LUNA_HOME/state/intents-state.json` に記録する。

## 内部設計

- ハートビート、スケジュール、日次整理は、それぞれ独立したイベントソースとして共通のEventExecutorを呼び出す。
- アジェンダはワークスペースのMarkdownとして持ち、構造の検証はしない。エージェントが読み書きする文書として扱うため。
- スケジュールの各発火は `ActiveExecutionSet` で追跡し、同じジョブの発火同士も直列化しない。
- `ScheduleController` は `AutomationCheckRunnerPort` だけに依存し、出力の空判定・切り詰め・ログ記録を担う。`ChildProcessCheckRunner` は `/bin/sh -c` を独立したプロセスグループで起動し、タイムアウト時はグループ全体へシグナルを送る。暴走した出力でメモリを使い切らないよう、標準出力は先頭、標準エラー出力は末尾をそれぞれ64000文字まで保持する。checkは発火の実行の一部として追跡されるため、`drain` は実行中のcheckと後続のエージェントの実行を待つ。
- 記録の掃除とワークスペースのゴミ箱の削除は、同じ `RetentionCleaner` を起動時と一定間隔で呼ぶ。`transcript_cleanup_enabled = false` のときは記録の掃除のクリーナーを作らない。
- 話題の予定は、`ConversationCoordinator` が実行に渡す入力を組み立てる時と steer する時に、`ConversationIntentPort.match(events)` の結果を該当メッセージの後に加える。`IntentMatcher` は人のDiscordメッセージだけを取り出し、`findFiringIntents`（domain）で判定する。`IntentFileStore` は `intents.toml` を毎回読む。予定の読み込みに失敗した時はログに残して発火させず、会話は止めない。
