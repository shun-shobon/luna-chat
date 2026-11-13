# Codex app-server から pi への移行設計

本書は移行期間中だけ使う設計書である。各フェーズの実装で確定した仕様と設計は `SPEC.md` と `ARCHITECTURE.md` に反映し、最終フェーズで本書を削除する。

## 1. 目的

- 会話・イベント実行・作業エージェントごとに、モデルと推論強度を選べるようにする。
- システムプロンプト、ツール、文脈管理、再試行を Luna のコードで制御する。
- 入力を JSON のユーザー文に詰めるのをやめ、ツール呼び出しと種類付きメッセージで表す。Effect の結果やタスクの報告もこの形にする。
- Codex app-server 由来の障害をなくす。実測で次の2つが起きている。
  - 不正な JSON 行による接続の再生成: 13日で17回
  - ChatGPT の OAuth 失効による停止: 約27時間

対象外: OpenAI 以外のプロバイダへの切り替え。設定の形はプロバイダを含めておくが、実装するのは `openai-codex` だけとする。

## 2. 決定済みの前提

| 項目       | 決定                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ハーネス   | `@earendil-works/pi-agent-core` と `@earendil-works/pi-ai`（1.5.2）を土台にする。ツールと圧縮の部品は `@earendil-works/pi-coding-agent` から import する |
| 認証・課金 | pi-ai の `openai-codex` プロバイダを使う。宛先は `chatgpt.com/backend-api/codex`、認証は ChatGPT サブスクの OAuth                                        |
| 画像生成   | `backend-api/codex/images/generations`（`gpt-image-2`）を Luna のツールから直接呼ぶ                                                                      |
| Web 検索   | Codex の `web.run` と同じ形のツールにし、`backend-api/codex/alpha/search` を呼ぶ                                                                         |
| ツール検索 | 当面は用意しない                                                                                                                                         |
| 配布       | `dist/` と `node_modules` で実行する（PR #43 で移行済み）                                                                                                |

PoC（2026-11-14、ローカルの business プラン、`originator: pi`）で確認したこと:

- 会話、steer、独自の型のメッセージ、`terminate` を返すツールが動く。
- 2回目以降のリクエストのキャッシュ率は99%を超える。
- `alpha/search` と `images/generations` がどちらも 200 を返す。

## 3. 現状の結合点

Codex に依存しているのは次の箇所で、移行後はすべて置き換える。

| 箇所                                        | 依存の内容                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent` モジュールのアダプター（約1,350行） | app-server の子プロセス、JSON-RPC、スレッドとターンの管理、生成型 `src/generated/codex`                                                                                              |
| `AgentRuntimePort`                          | 引数が Codex の形をしている（`config` に MCP 設定を渡す、`outputSchema`、ターンIDでの steer と interrupt）                                                                           |
| 会話・イベント実行・タスク                  | 入力を `{ source: ... }` の JSON 文字列にして渡す。最終出力の Structured Outputs を `parseEffectOutputs` で読む。`effect_results` と `turn_retry` のフォローアップターンを自前で回す |
| Discord MCP サーバー                        | loopback の `/mcp` と `/mcp/read` で Discord ツールを提供する                                                                                                                        |
| 開発者指示                                  | Codex 固有の文言がある（`request_user_input`、MCP、`danger-full-access` など）                                                                                                       |
| 設定                                        | `[agent]` の再起動・RPC・スレッド保持の項目、`CODEX_HOME`                                                                                                                            |
| ワークスペース                              | §9 を参照                                                                                                                                                                            |

## 4. 目標アーキテクチャ

```text
conversation / event / task ──► AgentSessionPort ──► PiAgentRuntime ──► pi-agent-core Agent ──► pi-ai (openai-codex)
        │ 種類付きメッセージ               │ セッションごとにツール・モデル・プロンプト
        ▼                                  ▼
   tool registry（旧 effect）◄──── ツール呼び出しを同一プロセスで即時実行
```

- Codex の子プロセス、JSON-RPC、loopback MCP、生成型はなくなる。
- エージェントの実行はすべて Luna のプロセス内の `Agent` インスタンスになる。1セッションにつき1つ持つ。認証とモデル一覧を持つ `Models` は全セッションで共有する。

### 4.1 エージェントのポート

`AgentRuntimePort` は、スレッドとターンを操作する形から、セッションを操作する形に置き換える。

```ts
type ModelSelection = Readonly<{
	provider: "openai-codex";
	model: string;
	thinking: ThinkingLevel;
}>;

type AgentSessionSpec = Readonly<{
	kind: "conversation" | "event" | "worker";
	ownerId: string;
	systemPrompt: string;
	tools: readonly LunaTool[];
	model: ModelSelection;
}>;

type AgentInputMessage = Readonly<{ kind: string; text: string; images?: readonly AgentImage[] }>;

type AgentRunResult =
	| Readonly<{ status: "completed"; finalText: string | null }>
	| Readonly<{
			status: "failed";
			reason: "usage_limit" | "transient_exhausted" | "fatal";
			message: string;
	  }>
	| Readonly<{ status: "aborted" }>;

interface AgentSessionPort {
	open(spec: AgentSessionSpec): AgentSession;
}

interface AgentSession {
	run(messages: readonly AgentInputMessage[]): Promise<AgentRunResult>; // アイドルになるまで実行する
	steer(message: AgentInputMessage): void; // 実行中なら次のリクエストの前に入る。アイドルなら次の run に入る
	abort(): Promise<void>;
	setModel(model: ModelSelection): void;
	close(): Promise<void>; // 記録を確定させる
}
```

- ターンIDは外に出さない。今の `TurnNotSteerableError`（13日で約40件）は、steer がキューに積まれる方式になるので起きなくなる。
- 一時的な失敗の再試行はアダプターの中で行う（§4.7）。会話・イベント実行・タスクにそれぞれある再試行と `turn_retry` 入力は削除する。
- 実行中であることと、再試行の待機中であることは、ダッシュボード向けの `snapshot` で公開する。

### 4.2 入力のメッセージ化

今の入力（`{ source: "conversation" | "event" | "effect_results" | "turn_retry" | "session_memory", ... }`）は、次のように置き換える。

| 現在                                                                          | 移行後                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `conversation`（history・events・tasks）                                      | 投稿1件ごとに `discord_message`、初回の履歴は `history`、タスク一覧は `task_board`                       |
| `event`（LunaEvent・tasks）                                                   | `event`（ハートビート、スケジュール、日次整理、HTTP）と `task_board`                                     |
| `effect_results`                                                              | なくなる。ツールの結果としてその場で返る                                                                 |
| `turn_retry`                                                                  | なくなる。アダプターが同じ記録のまま続きから再実行する                                                   |
| `session_memory`                                                              | `session_end`（記憶の保存を依頼する）                                                                    |
| `system.wait` の完了                                                          | `wait_elapsed`                                                                                           |
| タスクの報告や質問（依頼元への通知）                                          | `task_report`                                                                                            |
| 作業エージェントへの `task` / `task_messages` / `task_check` / `output_error` | `task_assignment` / `task_message` / `task_check`。`output_error` はなくなる（引数の検証はツールが返す） |

- アダプターはこれらを pi の独自ロールのメッセージとして記録する。LLM には `convertToLlm` で次の形の user メッセージにして渡す。

  ```text
  <luna_input kind="...">
  本文
  </luna_input>
  ```

  記録の上では種類が区別されたまま残る。

- 本文は送る側のモジュールが作る。外部から来た内容は今と同じく「信頼できないデータ」として扱い、ID などのメタデータと本文を分けて書く。
- Discord の添付画像は、今と同じく URL だけを渡す。見る必要があれば `view_image` で取得する。

### 4.3 Effect のツール化

今の Effect は、最終出力の JSON にまとめられ、ターンの後でバッチ実行される。移行後は、各 Effect をツールとして呼ばれた時点ですぐに実行し、結果をツールの結果として返す。

- `EffectDefinition`（zod のスキーマ、`parse`、`execute`、`describeTarget`）は、そのまま `LunaTool` の定義に使う。パラメータの JSON Schema は今と同じく `z.toJSONSchema` で作る。
- 同じ応答の中で呼ばれた複数のツールは、pi の並列実行で同時に動く。今のバッチ実行と同じ挙動になる。
- 失敗はツールの結果として返し、モデルはその場で立て直す。そのため `effect_results` のフォローアップターンはなくなる。
- 今は Discord への書き込みが2系統ある（MCP の書き込みツールと最終出力の Effect）。これを1系統のツールにまとめる。
- `system.wait` は `wait` ツールにする。`terminate: true` で実行を終え、指定時間の後に `wait_elapsed` を `run` で渡す。待機中は会話のアイドル判定を止める（今と同じ）。
- `http.respond` は応答を一時保存するツールにする。HTTP の応答は実行の完了時に確定する（今と同じ）。
- タイピングの解放（`EffectBatchPort.release`）は `run` の完了時に行う。
- 最終応答の本文はどこにも送らない。Discord への発言はすべてツールで行い、返信しないこともモデルの判断として認める。開発者指示でこのことを明示する。本文は記録（§4.8）に残すだけで、警告は出さない。

### 4.4 ツール一覧

ツール名は OpenAI の制約に合わせて `[a-zA-Z0-9_-]` だけにする。シェルとファイル操作には、GPT 系が学習している Codex のツール名と引数の形を使う。

| ツール                                                                                                                                       | 実装                                                                                                                                                                                                        | 会話 / イベント | 作業エージェント |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------- |
| `exec_command`、`write_stdin`                                                                                                                | 自作。パイプで起動し、`yield_time_ms` で途中の出力を返して session ID で継続する。PTY は使わない（`node-pty` のインストール時スクリプトを避けるため）。セッションを閉じるときにプロセスグループごと終了する | ◯               | ◯                |
| `read`、`edit`、`write`                                                                                                                      | `pi-coding-agent` の `createReadTool` / `createEditTool` / `createWriteTool`                                                                                                                                | ◯               | ◯                |
| `view_image`                                                                                                                                 | `read` の画像処理（photon で 2000px 以下に縮小）で画像を返す                                                                                                                                                | ◯               | ◯                |
| `web_run`                                                                                                                                    | 自作。`alpha/search` を呼ぶ。コマンドの形は Codex の `web.run` に合わせる                                                                                                                                   | ◯               | ◯                |
| `image_gen`                                                                                                                                  | 自作。`images/generations` と `images/edits` を呼び、ワークスペースに保存してパスを返す                                                                                                                     | ◯               | ◯                |
| Discord の読み取り（`read_message_history`、`list_channels`、`get_user_detail`、`list_guild_emojis`、`get_guild_emoji`）                     | MCP サーバーのハンドラーをツール定義へ移す                                                                                                                                                                  | ◯               | ◯                |
| Discord の書き込み（`send_message`、`reply_message`、`add_reaction`、`remove_reaction`、`start_typing`、`stop_typing`、`open_conversation`） | 今の Effect と MCP の書き込みを統合する                                                                                                                                                                     | ◯               | ×                |
| `task_create`、`task_message`、`task_cancel`                                                                                                 | 今の `task.*` Effect                                                                                                                                                                                        | ◯               | ×                |
| `task_report`                                                                                                                                | 今の `task.report` Effect                                                                                                                                                                                   | ×               | ◯                |
| `http_respond`                                                                                                                               | 今の `http.respond` Effect                                                                                                                                                                                  | ◯               | ×                |
| `wait`                                                                                                                                       | 今の `system.wait` Effect                                                                                                                                                                                   | ◯               | ◯                |

Codex にあって用意しないもの:

- サブエージェント（spawn、send、wait）: タスクで代わりにする。画像生成は `image_gen` を直接使うか `task_create` で委任する。
- `apply_patch`: 30日で184回と少ない。`edit` とシェルで足りる。
- code-mode、`update_plan`、`request_user_input`: 使わない。

### 4.5 モデルの選択と設定

`config.toml` に `[models]` を追加する。今の `[agent]` にある Codex 固有の項目は、最終フェーズで削除する。

```toml
[models.conversation]
model = "openai-codex/gpt-6.1-sol"
thinking = "medium"

[models.event]
model = "openai-codex/gpt-6.1-sol"
thinking = "medium"

[models.worker]
model = "openai-codex/gpt-6.1-sol"
thinking = "medium"

[models.compaction]
model = "openai-codex/gpt-6.1-terra"
thinking = "low"
```

- 値は起動時と設定の再読込時に、pi-ai のカタログ（`openai-codex` は固定のカタログ）と照合する。
- 既定値は上の値として SPEC に明記する。
- `/luna model` は今と同じく、そのセッションのモデルだけを変える（`AgentSession.setModel`）。

### 4.6 認証と使用枠

- **資格情報:** `LUNA_HOME/auth/credentials.json`（0600）に保存する。pi-ai の `CredentialStore` を自前で実装する。更新はプロセス内で直列化し、書き込みは一時ファイルからの rename で原子的に行う。
  - トークンの更新は pi-ai がリクエストの直前に行う（期限の5分前から）。
  - Codex とは別のログインにする。トークンを共有しないので、更新が衝突しない。
- **ログイン:** `luna-chat login`（`bin` のサブコマンド）で、デバイスコード方式でログインする。ヘッドレスの LXC でも、表示されたコードを手元のブラウザで入力すればよい。
- **認証の失敗:** 更新に失敗したら `auth_required` の状態にし、新しい実行を即座に失敗させる。この状態はダッシュボードに出し、エラーログを残す。Discord には通知しない。
- **使用枠:**
  - `GET chatgpt.com/backend-api/wham/usage` を定期的に取得し、`LUNA_HOME/state/usage.json` に原子的に書き出す。ダッシュボードにも表示する。
  - ワークスペースの使用量監視（`codex-usage-monitor`）は、Codex を起動する代わりにこのファイルを読むようにする。
  - ストリームの途中で届く使用枠（SSE のヘッダや WebSocket の `codex.rate_limits`）は、pi の `onResponse` / `onProviderStreamEvent` で拾い、同じ状態を更新する。`originator: pi` のときに届くかは未確認。

### 4.7 失敗と再試行

- pi の `Agent` は自動では再試行しない。既定ではタイムアウトもない。`streamFn` を包んで `timeoutMs` を指定し、`maxRetries` は 0 にする。
- 失敗の種類は、`onResponse` の HTTP ステータスと `onProviderStreamEvent` の生のイベントで判定する。pi のエラー文字列は判定に使わない。

  | 種類          | 判定                                | 扱い                                                                 |
  | ------------- | ----------------------------------- | -------------------------------------------------------------------- |
  | `usage_limit` | 429 と `usage_limit_reached`        | 再試行しない。`resets_at` を状態に記録する                           |
  | 一時的        | 5xx、接続の失敗・切断、タイムアウト | 15秒・60秒・180秒待ってから再試行する（今の `TURN_RETRY_DELAYS_MS`） |
  | 致命的        | それ以外                            | 再試行しない                                                         |

- 再試行するときは、エラーで終わったアシスタントメッセージと、それに続くツール結果を記録から外し、`continue()` を呼ぶ。待っている間に届いた steer はキューに残り、再開時に入る。
- 実行中に Luna が終了する場合は、`abort()` を呼ぶ。ツールには `AbortSignal` を渡し、シェルのプロセスはプロセスグループごと止める。

### 4.8 記録・圧縮・保持

- **記録:**
  - `LUNA_HOME/sessions/<日付>/<セッションID>.jsonl` に、`message_end` のたびに追記する。
  - 先頭のシステムメッセージは `message_end` で記録されないので、開いた時点で書き出す。
  - Luna を再起動しても、セッションは復元しない（今と同じ）。
- **保持:** `close()` で記録を確定させる。保持期間を過ぎたファイルは定期的に削除する。今の `thread/delete` の直列 RPC（タイムアウトで接続全体が落ちる原因だった）はなくなる。
- **圧縮:**
  - 直近のリクエストの `usage` が `contextWindow - reserveTokens` を超えたら圧縮する。
  - 要約は `[models.compaction]` のモデルで作る。`pi-coding-agent` の `findCutPoint` と `generateSummaryWithUsage` を使う（`prepareCompaction` はエクスポートされていないので使えない）。
  - 圧縮の結果（切り口と要約）はアダプターが保持する。`transformContext` で、毎回のリクエストを「システム → 要約 → 切り口より後の記録」に置き換える。記録そのものは書き換えず、圧縮したことを JSONL に追記する。
  - 要約の部分は次の圧縮まで変わらないので、キャッシュが効き続ける。
- **キャッシュ:** `sessionId`（`prompt_cache_key` と WebSocket の接続キー）は、セッションごとに固定する。

### 4.9 観測

- ダッシュボードの「エージェント」の欄には、Codex プロセスの状態の代わりに次の内容を出す。
  - 認証の状態
  - 使用枠
  - 実行中のセッション（種類、モデル、フェーズ、再試行の待機）
- 実行ごとに、リクエスト数、入力・キャッシュ読み・出力のトークン数、ツールの呼び出し回数をログに残す。キャッシュ率の監視に使う。

## 5. 移行の段階

| フェーズ            | 内容                                                                                                                                                                                                                     | 切り替える実行 | 完了の判定                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------- |
| 0. 準備             | ポート、ツール定義（Effect と Discord のツールの統合）、pi アダプター、資格情報、`luna-chat login`、使用枠の取得、`[models]` を実装する。この段階ではまだ使わない                                                        | なし           | 品質ゲートを通る。本番にログインして使用枠が取れる                               |
| 1. イベント実行     | ハートビート、スケジュール、日次整理、HTTP の one_shot を pi へ移す                                                                                                                                                      | `event`        | 3日間、失敗率とキャッシュ率が Codex と同等以上で、週の使用枠の増え方が変わらない |
| 2. 会話             | Discord と HTTP の会話を pi へ移す                                                                                                                                                                                       | `conversation` | 3日間、会話の失敗がなく、記憶の保存が動く                                        |
| 3. 作業エージェント | タスクを pi へ移す。長い実行での圧縮を確認する                                                                                                                                                                           | `worker`       | 圧縮を含む長いタスクが完了する                                                   |
| 4. 撤去             | Codex のアダプター、生成型、MCP サーバー、`@openai/codex`、`@hono/mcp`、`@modelcontextprotocol/sdk`、`[agent]` の Codex 用の項目、Dockerfile の codex-runtime を削除する。ワークスペースを書き換え（§9）、本書を削除する | —              | 本番に Codex のプロセスがない                                                    |

- フェーズ1から3の間は、Codex と pi のアダプターが同じプロセスに共存する。どの実行をどちらで動かすかは、フェーズごとにコンポジションルートで固定する。切り替えのための設定項目は設けない。
- 問題が出たら、`luna-chat-deploy` が残している前のリリースへ戻す（シンボリックリンクを切り替えて再起動する）。
- 共存している間、`AgentSessionPort` を使う実行と、今の `AgentRuntimePort` を使う実行が並ぶ。今のポートはフェーズ4で削除する。
- フェーズごとに、SPEC・ARCHITECTURE の更新を先に、実装を後にした別々のコミットにし、PR → CI → マージ → デプロイの順で進める。

## 6. テスト

- pi-ai の `fauxProvider` で応答を台本どおりに返し、アダプターと各実行の状態遷移をテストする。今の偽の app-server スクリプトは、フェーズ4で削除する。
- 必ずテストする境界:
  - ツールの成功・検証エラー・例外・abort
  - steer の入る位置
  - `terminate`
  - 再試行（一時的・使用上限・致命的、待機中の steer）
  - 圧縮の切り替え
  - 資格情報の更新の失敗
  - 使用枠の取得の失敗
- スナップショットテストは、固定の開発者指示と `luna_input` の描画だけに使う。
- 手動の E2E は、本番の times-luna と DM で行う。

## 7. 依存関係

- 追加: `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（いずれも 1.5.2 で固定）。
- インストール時スクリプトがある `@google/genai` と `protobufjs` は、pi-ai の必須依存として入る。`allowBuilds` で両方とも実行しない設定にする。
- 削除（フェーズ4）: `@openai/codex`、`@hono/mcp`、`@modelcontextprotocol/sdk`。

## 8. リスク

| リスク                                         | 対策                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `backend-api` の非公式な使い方が制限される     | ツールとプロバイダはアダプターの中に閉じておく。切り替え先として SIWC の正規経路（`openai-chatgpt.ts`、画像生成は不可）を残しておく |
| prolite プランでの挙動が PoC（business）と違う | フェーズ0で本番のアカウントでログインして確かめる                                                                                   |
| pi の破壊的変更（約4か月で11回）               | バージョンを固定し、更新は単独の PR でテストを通してから入れる                                                                      |
| 返信すべき場面で送信ツールを呼ばずに終わる     | 開発者指示で明示する。フェーズ2の完了条件で、会話の記録から確かめる                                                                 |
| 圧縮の質                                       | フェーズ3の完了条件で確かめる。要約モデルは設定で変えられる                                                                         |

## 9. ワークスペースの書き換え（フェーズ4）

| ファイル                                                                      | 変更                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.agents/skills/codex-usage-monitor/`、`tools/sensors/codex_usage_reset.py`   | Codex を起動する代わりに `LUNA_HOME/state/usage.json` を読む                                                     |
| `prompts/shun-moontv-morning.md`                                              | `exec` の長時間セッションの手順を `exec_command` / `write_stdin` の表現にする                                    |
| `prompts/shun-morning-image.md`、`LUNA.md` の画像生成の節、関係するプロンプト | 「画像生成担当のサブエージェントと組み込みの `image_gen`」を `image_gen` ツールの直接利用か `task_create` にする |
| `MEMORY.md`、`memory/topics/conversation-lessons.md`                          | Codex app-server や rollout でモデルを確認する手順を消す                                                         |
| `AGENDA.md`、`MEMORY.md` の Codex ログ抑止の項目                              | 不要になるので整理する                                                                                           |
| `cron.toml` の `codex-release-watch`                                          | 続けるか決める（§11）                                                                                            |

書き換える前に、ワークスペースをバックアップする。

## 10. 開発者指示

`src/runtime/developer-instructions.ts` と `src/modules/task/task-instructions.ts` を、次の点で書き直す。

- 入力が `luna_input` の種類付きメッセージであること。
- 外部への作用はすべてツールで行うこと。最終応答の本文は誰にも届かないこと。
- Codex 固有の記述（`request_user_input`、MCP、最終出力の JSON の形）を削除する。

書き直したものは、スナップショットテストで固定する。

## 11. 決定事項と未決事項

決定済み（2026-11-14）:

- 最終応答の本文は送らず、警告も出さない（§4.3）。
- サブエージェントは用意せず、タスクで代わりにする（§4.4）。
- 移行中の切り替え用の設定項目は設けない（§5）。
- 認証の失敗は、ダッシュボードとログで知らせるだけにする（§4.6）。

未決:

1. **`apply_patch`:** 推奨は用意しないこと。
2. **`codex-release-watch`:** Codex を使わなくなった後も続けるか。
