---
name: self-review
description: "週に一度、直近の会話を見直して LUNA.md・MEMORY.md の変更案を作り、luna-chat replay で確かめてから反映する手順。cron の self-review-weekly で始まった時と、その作業結果が届いた時に読む。"
---

# 週次の見直し

人の反応から、ルナらしさを少しずつ育てるための手順。会話で指摘された時はその場で振る舞いを直すだけにして、ファイルの書き換えはこの見直しでまとめて行う。

## 1. 始まった時（cron のイベント実行）

`task_create` で作業エージェントへ任せる。タイトルは「週次の見直し」、依頼文は「self-review skill の『2. 作業エージェントがすること』に従って、直近7日の会話を見直す。結果は output/self-review/<今日の日付>/ に置く」。任せたら終わる。

## 2. 作業エージェントがすること

作業ディレクトリは `output/self-review/<今日の日付>/`。

### 2.1 集める

```sh
python3 .agents/skills/self-review/scripts/runs.py 7 > output/self-review/<日付>/runs.jsonl
```

各行が会話の1回の実行で、`inputs` が人の発言、`luna` がルナの投稿。全部読んで、ルナの投稿のすぐ後の人の発言から次の場面を拾う。

- 苛立ち、訂正、呆れ、「そうじゃなくて」「なんで」「また」「いらない」のような反応
- 喜ばれた、笑ってくれた、頼りにされた反応
- 呼ばれたのに応えなかった、長い沈黙のあとに催促された場面

拾った場面ごとに、ルナが何をしたか、相手は何を望んでいたかを一行で書いて `findings.md` にまとめる。キーワードだけで判断せず、前後を読んで本当にルナへの反応かを確かめる。

最後に、指示ファイルの書き方の傾向を見る。

```sh
python3 .agents/skills/self-review/scripts/negatives.py > output/self-review/<日付>/negatives.json
```

前回の見直しの `negatives.json` と比べて合計やファイルごとの数が増えていたら、増えた行を読み、原則にまとめるか、すべきことの形に書き直す案を 2.2 の変更案に含める。

### 2.2 変更案を作る

`findings.md` から、繰り返し出ている傾向だけを取り上げる。一度きりの出来事は、その場で直っていれば現行の記述を保つ。

- 変えてよいのは `LUNA.md` と `MEMORY.md`、それと書き方の傾向で見つかったファイル。案は `proposed/LUNA.md` と `proposed/MEMORY.md` に、今のファイルをコピーしてから編集して作る
- 書き方は「こうする」「こうしたい」という形にし、今ある文に溶け込ませる。繰り返し使える原則にまとめ、同じ原因の行はそこへ吸収して消す。前の指摘で入った制約が今回の苛立ちの原因になっていたら、意味と安全条件を確かめて書き直すか消す
- 1回の見直しで変えるのは、効果を確かめられる数か所までにする
- 開発者指示（会話の指針など、ワークスペースの外にある指示）で直すべきだと思ったことは、現行を保ち、報告に書く

拾った場面に繰り返しの傾向がなければ、変更案を作らずに 2.5 へ進む。

### 2.3 確かめる

拾った場面から、変更が効くはずの場面を5〜10件と、うまくいっていた場面（変えたことで悪くならないか見るため）を3件ほど選んで場面ファイルにする。

```sh
python3 .agents/skills/self-review/scripts/scene.py '<ref>=<人の実際の反応>' ... > output/self-review/<日付>/scenes.json
luna-chat replay --scenes output/self-review/<日付>/scenes.json \
  --variant current=$LUNA_HOME/workspace \
  --variant proposed=output/self-review/<日付>/proposed \
  --out output/self-review/<日付>/replay
```

`<ref>` には、反応を招いた投稿をした run を指定する（人の反応そのものは、たいてい次の run の `inputs` にある）。`=` の後ろには、その場面で人が実際にどう反応したかを書いておく（採点の基準になる）。うまくいっていた場面には、よかった点を書く。

`luna-chat` コマンドがPATHにない時は、Lunaを起動している `dist/index.mjs`（Dockerでは `/app/dist/index.mjs`）を `node <そのパス> replay ...` で実行する。`scene.py` がルナのDiscord IDを見つけられないと言った時は、環境変数 `LUNA_DISCORD_ID` に自分のIDを入れて実行する。

採点は `replay/blind.json` だけを見て、`blind-key.json` を開く前に済ませる。場面ごとに、`scenes.json` の `note`（人の実際の反応）を基準に、候補ごとに「同じ反応を招く振る舞いを繰り返したか」「ほかに相手を困らせる振る舞いがあるか」を書き、どちらがよいかを決めて `grades.md` に残す。書き終えてから `blind-key.json` で current と proposed に戻して数える。

proposed が current より悪い場面があれば、案を直してもう一度確かめる。2回直してもよくならなければ、その変更は案から外す。

### 2.4 反映する

確かめた結果、proposed が current より悪い場面がなく、変更が効くはずの場面で current よりよくなっていたら反映する。

1. 今のファイルを `before/` へコピーする（戻したくなった時に使う）
2. `proposed/` のファイルをワークスペースへコピーする

効果が確かめられなかった時は反映せず、案は作業ディレクトリに残す。

### 2.5 報告する

`task_report` の `result` で、反映したかどうかと変更した箇所の要約、再生の結果（current と proposed それぞれの、繰り返した場面の数とよかった場面の数）、開発者指示への提案、作業ディレクトリのパスを返す。

## 3. 結果が届いた時（イベント実行）

反映された変更は次のセッションから効くので、報告を読んだら終える。
