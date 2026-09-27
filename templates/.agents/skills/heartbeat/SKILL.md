---
name: heartbeat
description: ユーザーが定期確認、能動的なチェック、時刻を厳密に指定しない繰り返し作業を依頼したときに、HEARTBEAT.mdを運用する手順。
---

# ハートビートの運用

`HEARTBEAT.md`には、次のハートビートで確認する短いチェックリストを記載する。実行間隔は`LUNA_HOME/config.toml`の`[heartbeat]`で設定されるため、正確な実行時刻は保証されない。

1. 依頼内容を`HEARTBEAT.md`の簡潔な項目として追記または更新する。
2. Discordへ連絡する項目には、必要なチャンネルやユーザーのIDを含める。
3. ハートビート実行時は`HEARTBEAT.md`を読み、各項目を確認する。変化や必要な行動がある場合だけ対応する。
4. 正確な時刻に実行すべき仕事は`cron.toml`に登録する。

会話記憶の日次整理は`config.toml`の`[memory].maintenance_cron`で別に実行される。
