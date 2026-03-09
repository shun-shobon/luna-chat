# RUNBOOK.md

## 1. 目的

この文書は実行ルールである。  
一度読んだら常に従う。

## 2. 不変ルール

1. 返信対象は Guild では `$LUNA_HOME/config.toml` の `[discord].allowed_channel_ids`、DM では `[discord].allow_dm` に従う。
2. 指定チャンネル内の投稿（メンション有無を問わない）を AI 処理対象とする。
3. `mentionedBot` は AI 入力へ含めるが、ハンドラで優先制御しない。
4. スレッドは常に非対応。DM は `[discord].allow_dm` で有効/無効を切り替える。
5. 会話ログ本文は永続保存しない。
6. AI 入力には現在メッセージを必ず含め、セッションキー内で未注入の履歴スコープの場合のみ直近 10 件を追加する（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）。
7. 追加履歴は `read_message_history` で都度取得できる（`beforeMessageId` / `afterMessageId` / `aroundMessageId` は排他指定）。
8. AI は必要時に `start_typing` で入力中表示を開始でき、`send_message` 成功時または Discord turn 完了時に自動停止される。
9. Bot 直接メンション時の自動 typing 送信も継続する。
10. ワークスペース（`$LUNA_HOME/workspace`）のドキュメントを AI instructions に読み込む。
11. 自己改善ドキュメントの自動更新フローは現時点で未実装。
12. 秘密情報をログやドキュメントに平文出力しない。
13. `STATUS.md` は作業ごとに AI が更新する。
14. heartbeat は `$LUNA_HOME/config.toml` の `[heartbeat].cron_time` に従って自動実行する（未設定時は毎時 00 分 / 30 分）。
15. `time_zone` を未設定にした場合、heartbeat と cron prompt はシステムタイムゾーンで実行する。
16. heartbeat 実行時は以下の固定プロンプトを使う。  
    `HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。
17. cron prompt は `$LUNA_HOME/workspace/cron.toml` の `[jobs.<id>]`（`cron` / `prompt` / `oneshot`）に従って実行する。
18. `cron.toml` の変更は再起動なしで反映し、不正設定時は前回有効スケジュールを維持する。
19. `oneshot = true` の cron prompt は1回試行後に `cron.toml` から削除する。
20. `codex app-server` は起動時に 1 回だけ起動し、Discord / heartbeat / cron prompt で共有する。
21. Discord セッションは turn 完了後も保持し、通常チャンネル投稿は `channelId` ごとに 1 セッションを再利用し、DM 投稿は `userId` ごとに別セッションを再利用する。各セッションは最終メッセージから 30 分新規メッセージがなければ閉じる（turn 実行中なら完了後に閉じる）。

## 3. 実行手順

### 3.1 起動前チェック

1. `DISCORD_BOT_TOKEN` が設定されていることを確認する。
2. `LUNA_HOME` 未設定時は `~/.luna` を使用することを確認する。
3. `$LUNA_HOME/config.toml` が存在しない場合は初回起動で自動生成されることを確認する。
4. `config.toml` の `[discord].allowed_channel_ids` が文字列配列であることを確認する（空配列は許容）。
5. `config.toml` の `[discord].allow_dm`（boolean）を必要に応じて設定する（未設定時は `false`）。
6. `config.toml` の `[heartbeat].cron_time`（cron 文字列）を必要に応じて設定する（未設定時は `0 0,30 * * * *`）。
7. 必要時のみ `time_zone`（IANA タイムゾーン）を設定する（未設定時はシステムタイムゾーン）。
8. 起動時に `LUNA_HOME` / `$LUNA_HOME/workspace` / `$LUNA_HOME/codex` / `$LUNA_HOME/logs` が自動作成されることを確認する。
9. 起動時に `templates` 配下の通常ファイルが再帰的に `$LUNA_HOME/workspace` へ不足分のみコピーされ、既存ファイルは上書きされないことを確認する（空ディレクトリは許容、シンボリックリンクは不可）。
10. `$LUNA_HOME/workspace/cron.toml` が存在することを確認する（初回起動でテンプレート作成される）。

### 3.2 開発時コマンド

1. `pnpm run gen`
2. `pnpm run dev`
3. `pnpm run typecheck`
4. `pnpm run lint`
5. `pnpm run knip`
6. `pnpm run format:check`
7. `pnpm run build`

### 3.3 運用時の基本挙動

1. 受信イベントでチャンネル判定（スレッド除外、DMは`allow_dm`で判定、Guildは許可外除外）を実施する。
2. 現在メッセージを AI に渡し、セッションキー内で未注入の履歴スコープの場合のみ直近 10 件を初回注入する（通常チャンネル投稿は `channelId` 単位、DM 投稿は `userId` 単位）。
3. AI は必要時に `read_message_history` / `send_message` / `add_reaction` / `start_typing` / `list_channels` / `get_user_detail` を使用する。`send_message` は任意の `replyToMessageId` 指定時に返信投稿として送信し、任意の `filePaths` で複数ファイルを添付できる。`text` は任意だが、`text` または `filePaths` の少なくとも一方が必要である。`filePaths` の相対パスは AI ワークスペース基準で解決し、ワークスペース外への脱出は拒否する。MCP tool の応答はプレーンテキストで返る。
4. AI エラー時は返信せず終了し、失敗ログを確認する。
5. アプリケーションログは標準出力に加えて `$LUNA_HOME/logs/YYYYMMDD-HHmmss-SSS.log`（JSONL）にも出力される。
6. heartbeat 実行が失敗してもプロセスは継続し、次の cron 周期で再実行する。
7. cron prompt 実行が失敗してもプロセスは継続し、`oneshot=false` は次周期で再実行する。

## 4. プロンプト運用

AI には最低限以下を渡す。

1. ルナの人格定義とセーフティガード
2. 現在メッセージ（author/channel/message）
3. 直近メッセージ履歴
4. 返信・リアクション時は `discord` ツールを使う制約

## 5. 失敗時対応

1. Discord 投稿失敗:
   - 失敗をログ化する。
2. AI 呼び出し失敗:
   - 返信せず終了する。
   - 失敗理由をログで確認する。
3. 設定不備:
   - 起動を中断する。

## 6. 変更管理

1. 仕様変更は `SPEC.md` に反映する。
2. 実装方針変更は `PLAN.md` と `ARCHITECTURE.md` に反映する。
3. 運用ルール変更は `RUNBOOK.md` に反映する。
4. 進捗・現況は `STATUS.md` に反映する。

## 7. セキュリティ運用

1. トークン値はマスクする。
2. 会話内容を外部へ二次利用しない。
3. 不要なログを残さない。
