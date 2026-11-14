---
name: x-status-fetch
description: x.com または twitter.com の投稿URLや投稿IDから、本文・投稿者・投稿日時・メディアを取得する。Xのリンクを読んで話す時、要約や真偽の確認、引用の前に原文を確かめる時に使う。
---

# Xの投稿を読む

FxEmbed の Status Fetch API（`https://api.fxtwitter.com/status/<id>`）で投稿を取得する。

```sh
python3 .agents/skills/x-status-fetch/scripts/fetch_x_status.py '<URLまたは投稿ID>'
```

`https://x.com/<user>/status/<id>`、`https://twitter.com/<user>/status/<id>`、数字だけの投稿IDを受け付ける。標準出力はJSONで、`ok` が `true` なら `response.tweet` に投稿がある。

- 本文は `tweet.text`、投稿者は `tweet.author.name` と `tweet.author.screen_name`、日時は `tweet.created_at`、画像や動画は `tweet.media`
- 引用された投稿は `tweet.quote` にある
- 画像の中身を話す時は、`tweet.media` のURLから画像を取得して実際に見る

取得できなかった時は、`status` から理由を読んでそのまま伝える。`401` は非公開の投稿、`404` は削除かURLの誤り、`500` や通信の失敗は一時的なものなので少し待って取り直す。
