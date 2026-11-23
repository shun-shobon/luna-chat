# デスクトップ

ルナ専用のデスクトップを任意で入れられる。人は neko（WebRTCの画面共有）で同じ画面を見て、マウスとキーボードで操作に加われる。Lunaのプロセスとは独立した systemd のサービス群で、Linux（Ubuntu 24.04）のホストに `install.sh` を root で実行して入れる。Lunaのコードはデスクトップを参照せず、ルナはワークスペースのskill `luna-desktop` を通じてだけ使う。

neko のパスワードを知る者は、ルナのログイン済みの Chrome を含むデスクトップを見て操作できる。neko はLANへ待ち受ける。

## サービス

| サービス                  | 内容                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `luna-desktop-xvfb`       | 画面 `:99`（1920×1080）。解像度は固定                                                                                                                                            |
| `luna-desktop-openbox`    | ウィンドウマネージャー                                                                                                                                                           |
| `luna-desktop-dbus`       | デスクトップのD-Busセッション。AT-SPI（アクセシビリティ）のバスもここから起動する                                                                                                |
| `luna-desktop-pulseaudio` | 音声の出力先（null sink）                                                                                                                                                        |
| `luna-desktop-chrome`     | Google Chrome。プロファイルは `LUNA_HOME/desktop/chrome-profile` でログイン状態を保つ。CDPを `127.0.0.1:9222` で待ち受け、アクセシビリティツリーを公開する。終了すると再起動する |
| `luna-desktop-neko`       | neko。`8080/tcp` で閲覧画面とAPI、`59000/udp` でWebRTCを待ち受ける                                                                                                               |
| `luna-desktop.target`     | 上記をまとめて起動・停止する                                                                                                                                                     |

すべて実行ユーザー `luna` で動く。共通の環境変数（`DISPLAY`、`XDG_RUNTIME_DIR=/run/luna-desktop`、D-BusとPulseAudioのソケット、`LANG=ja_JP.UTF-8`）は `/opt/luna-desktop/etc/session.env` に置く。

## neko

neko の設定は `/opt/luna-desktop/etc/neko.yaml` と、ホストごとの値を持つ `/etc/luna-desktop/neko.env`（root のみ読める）に分ける。`neko.env` には WebRTC で広告するホストのLANのIP（`NEKO_WEBRTC_NAT1TO1`）、閲覧・操作用と管理者用のパスワードを書く。`install.sh` は `neko.env` がなければ、ホストの最初のIPと乱数のパスワードで作る。

- 認証: neko の multiuser。どちらかのパスワードと任意の表示名でログインする
- 操作権: 操作した人がそのまま操作権を得る（`implicit_hosting`）。ルナの操作（CDP・AT-SPI・xdotool）は neko の操作権を経由せず、人の操作と排他にしない
- 配信: 誰かが見ている間だけ映像をエンコードする。ポインタを映像に描き込み、ルナが動かしたポインタも見える

## skill `luna-desktop`

`install.sh` は skill `luna-desktop`（`SKILL.md`、操作用の `scripts/desktop.py`、CDP用の `playwright-core`）を `LUNA_HOME/workspace/.agents/skills/luna-desktop/` に上書きで置く。

- `desktop.py` は AT-SPI でアプリの部品を番号付きで一覧し、番号を指定して操作する。部品が操作に応じない時はポインタやキーの入力に切り替える。ASCII以外の文字は空きキーコードへまとめて割り当ててから打ち、キーマップを読めない時だけクリップボードから貼り付ける
- 各操作のあとに画面全体のスクリーンショットを `/run/luna-desktop/screens/`（直近30枚）に保存し、直前の画面から変わったかを返す
- 入力欄の値を置き換えた時は、値を読み直して一致したかを返す
- `wallpaper` は指定した画像を `LUNA_HOME/desktop/wallpaper` へコピーして、すぐに貼り替える
