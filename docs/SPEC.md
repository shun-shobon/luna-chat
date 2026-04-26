# SPEC.md

## 1. 目的

luna-chat は、身内向け Discord サーバーで雑談に自然参加する Bot を作るプロジェクトである。  
人格名は「ルナ」とし、優しい少女の雰囲気で会話する。口調は敬語とため口を混在させる。

## 2. 対象ユーザー

- 開発者本人
- 開発者の身内コミュニティ

多少の粗さや不完全さは許容する。

## 3. プロダクト要件（MVP）

### 3.1 会話参加

- 指定されたチャンネルでのみ動作する。
- 指定チャンネル内の投稿（メンション有無を問わない）を AI 処理対象とする。
- DM 投稿の処理有無は `$LUNA_HOME/config.toml` の `[discord].allow_dm` で切り替える（`false` で無効、`true` で有効）。
- `mentionedBot` 情報は AI 入力に含めるが、メンション優先制御はコード上で実装していない。
- すべての投稿へ返信する必要はない。
- Discord 投稿起点に加えて heartbeat 起点でも AI を実行する。
- heartbeat は `$LUNA_HOME/config.toml` の `[heartbeat].cron_time` に従って自動実行する（未設定時は毎時 00 分 / 30 分）。
- heartbeat と cron prompt のタイムゾーンは `$LUNA_HOME/config.toml` のトップレベル `time_zone` で任意指定できる（未設定時はシステムのタイムゾーンを使用）。
- heartbeat 実行時のプロンプトは以下の固定文を使う。  
  `HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。
- `$LUNA_HOME/workspace/cron.toml` の `[jobs.<id>]`（`cron` / `prompt` / `oneshot`）に従って任意プロンプトを定期実行する。
- `cron.toml` の変更は監視し、再起動なしで反映する。
- `oneshot = true` の cron prompt は1回試行後（成功/失敗を問わず）`cron.toml` から削除する。
- AI は必要に応じて tool use（`send_message` / `add_reaction` / `start_typing` / `list_channels` / `get_user_detail`）を使う。
- `send_message` は `channelId` または `userId`（DM）のどちらか一方を受け取り、任意で `replyToMessageId` と `filePaths` を指定できる。`text` は任意とし、`text` または `filePaths` の少なくとも一方を必須とする。`replyToMessageId` 指定時は該当メッセージへの返信として投稿する。
- `send_message.filePaths` は `string[]` で複数ファイルを受け付け、各要素は絶対パスまたは AI ワークスペース基準の相対パスを指定できる。相対パスがワークスペース外へ脱出する場合は拒否する。
- `add_reaction` は `channelId` または `userId`（DM）のどちらか一方と `messageId` / `emoji` を受け取る。
- `start_typing` は `channelId` または `userId`（DM）のどちらか一方を受け取る。
- `start_typing` で開始した入力中表示は Discord turn 完了時、または `send_message` 成功時に自動停止する。
- `list_channels` は `$LUNA_HOME/config.toml` の `[discord].allowed_channel_ids` に含まれるチャンネル情報のみを返し、各チャンネルに `guildId` と `guildName` を含める（チャンネル種別の数値は返さない）。
- `get_user_detail` は `userId` と `channelId` を受け取り、`user` として基本ユーザー情報に `displayName` / `nickname` を加えた単一オブジェクトを返す（対象ユーザーが取得できない場合は `user=null`）。
- Discord MCP の tool レスポンスは JSON 文字列ではなくプレーンテキストで返す。

### 3.2 文脈取得

- メッセージログを永続保存しない。
- Discord メッセージと履歴は `userRolePrompt` 内の `source` 付き XML 風入力として AI に渡し、添付ファイルは自動保存せず `id` / `name` / `url` を含める。
- AI 呼び出し時は現在メッセージに加えて、セッションキー内で未注入の履歴スコープに限り直近 10 件の履歴を初期入力として渡す（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）。
- さらに過去履歴が必要な場合、AI は tool use（`read_message_history`）で都度取得する。
- `read_message_history` は 1 回あたり最大 100 件（未指定時 30 件）を取得でき、複数回呼び出せる。
- `read_message_history` は `beforeMessageId` / `afterMessageId` / `aroundMessageId` のいずれか1つを任意指定できる（同時指定不可）。
- `read_message_history` の返却は `source` 付き XML 風入力と同形式で整形し、Discord 添付の `id` / `name` / `url` を含める。

### 3.3 推論と制御

- 推論、tool use、ワークフロー制御は Codex CLI app-server を中心に実行する。
- Codex CLI app-server はアプリケーション起動時に 1 回だけ起動し、Discord / heartbeat / cron prompt で共有する。
- Discord 受信時は新規メッセージごとにセッションを作り直さず、通常チャンネル投稿では `channelId` ごとに 1 つのセッション（thread）を再利用する。
- DM 投稿では `userId` ごとに別セッション（thread）を再利用する。
- Discord セッションは最終メッセージから 30 分新規メッセージがなければ閉じる（turn 実行中の場合は完了後に閉じる）。
- 現時点で外部サービス連携は必須にしない（Codex CLI 既定機能の利用は可）。

### 3.4 ワークスペース運用

- luna-chat 本体コードのディレクトリとは別に、Codex CLI 用ワークスペースディレクトリを持つ。
- `LUNA.md` / `SOUL.md` などの運用ドキュメントは Codex CLI 用ワークスペースに配置する。
- 現行実装には、AI によるドキュメント自動更新フローは含まれない。

### 3.5 エラー応答

- AI 呼び出し失敗時は、返信せず処理を終了する。
- 失敗内容はログに記録する。

### 3.6 コマンド

- `!ping` のようなテスト用コマンドは MVP 必須機能ではない（最終的に不要）。

## 4. 非機能要件

- 初期の正規実行環境はローカル常駐とする。
- VPS / コンテナは将来の実行形態として許容する。
- 明示的な性能 SLA は当面設けない。
- セキュリティの最低要件として、秘密情報（トークンなど）はドキュメントやログに平文出力しない。

## 5. 設定要件

- 複数チャンネル ID を設定可能にする。
- 許可チャンネルは `$LUNA_HOME/config.toml` の `[discord].allowed_channel_ids`（文字列配列）で設定する。
- 例: `allowed_channel_ids = ["1234567890", "2345678901"]`
- DM 応答可否は `$LUNA_HOME/config.toml` の `[discord].allow_dm`（boolean）で設定する。
- AI モデル/推論努力値は `config.toml` では設定せず、Codex 側の既定設定を使用する。
- heartbeat 実行タイミングは `$LUNA_HOME/config.toml` の `[heartbeat].cron_time` で設定可能にする（未設定時 `0 0,30 * * * *`）。
- heartbeat と cron prompt の共通タイムゾーンは `$LUNA_HOME/config.toml` のトップレベル `time_zone` で設定可能にする（未設定時はシステムタイムゾーン）。
- cron prompt は `$LUNA_HOME/workspace/cron.toml` の `[jobs.<id>]` で設定可能にする（`cron` / `prompt` / `oneshot`）。

## 6. 受け入れ条件

1. 指定外チャンネルでは処理しない。
2. 指定チャンネル内の投稿（メンション有無を問わない）を AI へ渡せる。
3. 現在メッセージの `mentionedBot` 情報を AI 入力へ含められる。
4. 履歴永続化なしで、セッションキー内で未注入の履歴スコープのみ直近 10 件を `source` 付き XML 風の初期文脈として渡せる。
5. 必要時に `read_message_history` で `source` 付き XML 風の追加履歴取得ができる（`beforeMessageId` / `afterMessageId` / `aroundMessageId` は排他、Discord 添付の `id` / `name` / `url` を含む）。
6. AI 失敗時は返信せず終了し、失敗ログを確認できる。
7. ワークスペース運用（`$LUNA_HOME/workspace`）で `LUNA.md` / `SOUL.md` を読み込める。
8. `send_message` / `add_reaction` / `start_typing` / `list_channels` / `get_user_detail` を tool use で実行できる。`send_message` / `add_reaction` / `start_typing` は `channelId` または `userId`（DM）のどちらか一方で対象を指定でき、`send_message` は任意で返信先IDと複数添付ファイルパスを指定でき、`text` または `filePaths` の少なくとも一方が必要である。
9. heartbeat は `[heartbeat].cron_time` で設定したスケジュールで実行される（未設定時は毎時 00 分 / 30 分、タイムゾーン未設定時はシステムタイムゾーン）。
10. heartbeat 実行時は `source` 付き XML 風で実装済みの固定プロンプトが渡される。
11. `allow_dm = false` では DM を処理せず、`allow_dm = true` では DM 投稿を AI へ渡せる。
12. `workspace/cron.toml` の cron prompt ジョブが `source` 付き XML 風入力で定期実行され、`oneshot = true` ジョブは1回試行後に設定ファイルから削除される。
13. `cron.toml` の変更が再起動なしで反映される。不正設定時は前回有効スケジュールを維持する。
14. Codex app-server が起動時に 1 回だけ起動し、Discord / heartbeat / cron prompt で共有される。
15. Discord セッションは turn 完了後も再利用され、通常チャンネル投稿は `channelId` ごとに 1 セッション、DM 投稿は `userId` ごとのセッションで運用され、各セッションは 30 分アイドルで閉じる。
16. Discord MCP の各 tool はレスポンスをプレーンテキストで返す。
