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
