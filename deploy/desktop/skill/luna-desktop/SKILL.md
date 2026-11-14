---
name: luna-desktop
description: ルナ専用のデスクトップ（常駐のChromeとデスクトップアプリ）を操作する。ログインが必要なサイト、人に見せながら進めたいブラウザ作業、ブラウザ以外の画面操作に使う。しゅんはnekoから同じ画面を見て、いつでも操作に加われる。
---

# ルナのデスクトップ

1440×900 の画面（`DISPLAY=:99`）に Google Chrome が常駐している。Chrome のプロファイルはログイン状態を保つので、一度ログインしたサイトは次も使える。しゅんは neko（`http://<ホスト>:8080`）で同じ画面を見ていて、マウスやキーボードで手伝える。ログインや二段階認証が必要な時は、画面をその場面まで進めてからしゅんに声をかける。

ログインの要らない調べものや大量のページ取得は、これまでどおり使い捨てのブラウザやHTTPで並行して進める。デスクトップは1つの画面を共有しているので、一度に1つの作業で使う。

## ブラウザ: CDPで常駐のChromeにつなぐ

Webページの操作はPlaywrightで常駐のChromeにつなぐのが確実。自分用のタブを開いて作業し、終わったらそのタブを閉じる。`browser.close()` は接続を切るだけで、Chromeと他のタブは残る。

```js
const { chromium } = require(
	`${process.env.LUNA_HOME}/workspace/.agents/skills/luna-desktop/scripts/node_modules/playwright-core`,
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto("https://example.com/");
// ... 操作 ...
await page.close();
await browser.close();
```

`chromium.launch()` で別のブラウザを起動すると、ログイン状態も画面も共有されないので、常駐のChromeを使う時は必ず `connectOverCDP` にする。

## 画面: アクセシビリティツリーで操作する

ブラウザの外側（タブ、アドレスバー、ダイアログ）やデスクトップアプリは `scripts/desktop.py` で操作する。画面の部品を番号付きで一覧し、番号を指定して操作する。

```sh
S=.agents/skills/luna-desktop/scripts/desktop.py
$S apps                                   # アプリとウィンドウの一覧
$S state --app chrome --query 検索          # 部品の一覧（番号・役割・名前・値・位置・操作）とスクリーンショット
$S click --index 12                       # 部品を押す
$S set-value --index 3 --text "ねこ"       # 入力欄の値を置き換える
$S key Return                             # キー入力（ctrl+l、alt+Tab なども可）
$S type --text "hello"                    # フォーカス中の場所へ文字を打つ
$S click --x 700 --y 400                  # 座標でクリック（部品がツリーにない時）
$S scroll --x 700 --y 400 --direction down --amount 5
$S drag --from 100,200 --to 300,200
$S screenshot --crop 900,400,500,300      # 一部を拡大して読む
$S activate --window 0x00800003           # ウィンドウを前に出す
```

`--app` を省くと前面のアプリを対象にする。部品が多い画面では `--query` で絞る。番号は直前の `state` の一覧の番号で、画面が変わると使えなくなるので、操作で画面が変わったら `state` を取り直してから次の番号を選ぶ。

操作の結果はJSONで返る。

- `via`: `accessibility:press` などはアプリに直接操作を頼んだもの、`pointer`・`keyboard` はマウスやキーの入力を送ったもの
- `screenshot`: 操作後の画面。`view_image` で見て、思った通りになったかを確かめる
- `screenChanged`: 直前の画面から変わったか。`false` なら効いていない可能性が高いので、画面を見てから別の方法（座標クリック、キー操作）を試す
- `set-value` の `verified`: 入力欄の値を読み直して一致したか

スクリーンショットは画面と同じ 1440×900 なので、画像上の座標をそのまま `click --x --y` に使える。画像は `/run/luna-desktop/screens/` に直近30枚だけ残るので、残したい画面は作業ディレクトリへコピーする。

送信・購入・削除・投稿・設定変更のように取り消しにくい操作は、依頼の中でそうしてほしいと言われている時に行い、結果の画面を確かめてから報告する。
