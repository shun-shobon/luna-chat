---
name: cron
description: ユーザーが定期実行、時刻指定の作業、一度きりのリマインダーを依頼したときに、workspaceのcron.tomlへ正しいjobを登録する手順。
---

# cron.tomlの編集

正確な時刻に実行する仕事は、workspace直下の`cron.toml`に登録する。定期的な確認をまとめて行い、厳密な時刻が不要なら`HEARTBEAT.md`を使う。

1. 既存の`cron.toml`を読み、job IDの重複を避ける。
2. 定期実行には`kind = "recurring"`と5 fieldの`cron`を指定する。時刻は実行環境のローカルタイムゾーンで解釈される。
3. 一度きりの実行には`kind = "one_shot"`とオフセット付きISO 8601日時の`at`を指定する。
4. `id`、`enabled`、`kind`、`prompt`を必ず指定する。`prompt`には実行時に必要な送信先IDなどを含める。
5. 編集後にTOMLの形式と各jobの必須項目を確認する。不正な変更は適用されない。

```toml
[[jobs]]
id = "morning-check"
enabled = true
kind = "recurring"
cron = "0 9 * * 1-5"
prompt = "平日の確認を行い、必要ならDiscordチャンネル(ID: 1234567890)へ報告する"

[[jobs]]
id = "reminder"
enabled = true
kind = "one_shot"
at = "2030-01-01T09:00:00+09:00"
prompt = "Discordチャンネル(ID: 1234567890)へリマインダーを送る"
```

例の日時とIDは依頼内容に合わせて置き換える。

## checkで変化があった時だけ実行する

新着や変化の監視など、大半の回で何もしない定期jobには`check`を付ける。`check`はrecurring jobだけに指定でき、発火のたびにworkspaceをカレントディレクトリとして`/bin/sh -c`で実行される。

- 終了コード0で標準出力があれば、その内容がイベントの`data.check_output`に入ってjobが実行される。32000文字を超えた分は切り捨てられ、`data.check_output_truncated`が`true`になる。
- 終了コード0で標準出力が空なら、jobは実行されない。
- 非0終了や120秒のタイムアウトは失敗として記録され、jobは実行されない。

変化検出スクリプトは次の形にする。

1. 前回の状態を保存した状態ファイルを読み、取得した最新の結果と比べる。
2. 新着や変化の分だけを標準出力へ出し、状態ファイルを更新して0で終了する。
3. 変化がなければ何も出さずに0で終了する。
4. 取得や解析に失敗したら状態ファイルを更新せず、非0で終了する。エラー内容は標準エラー出力へ出す。

前回のcheckやjobが終わる前でも次の発火は並行して実行されるため、cronの間隔より十分短い時間で終わるようにする。`prompt`には`data.check_output`の扱い方と報告先を書く。

```toml
[[jobs]]
id = "release-watch"
enabled = true
kind = "recurring"
cron = "*/30 * * * *"
check = "./scripts/check-release.sh"
prompt = "data.check_outputにある新しいリリースを要約し、Discordチャンネル(ID: 1234567890)へ報告する"
```
