# エージェントの実行基盤

エージェントのセッションを開いて実行する仕組み（モデルの提供元、システムプロンプト、再試行と圧縮、認証と使用枠、再生）を定める。セッションに渡すツールは [tools.md](./tools.md) にある。

## モデルの提供元

エージェントは、Lunaのプロセス内でpi（`@earendil-works/pi-agent-core` と `@earendil-works/pi-ai`）を使って実行する。モデルの提供元は次の2つで、`[models]` ごとに選べる。

- `openai-codex`: ChatGPTのサブスクリプションをOAuthで使う。
- `claude-code`: Claudeのサブスクリプション（Pro・Max）を、Claude Code CLI を通して使う。モデルは `claude-fable-5-2`・`claude-opus-5-5`・`claude-sonnet-5-5`・`claude-haiku-5-5`。

会話・イベント実行は、それぞれ `[models]` で指定したモデルと推論強度を使う。会話は `/luna model` でセッションごとに変更できる。作業エージェントは依頼元が `task_create` で選んだもの（[tasks.md](./tasks.md)）、音声モードの返事は `[models.voice]` を使う。

## システムプロンプト

エージェントのセッションを開くたびに、固定の開発者指示、`.agents/skills/` 配下のskill一覧（Agent Skillsの `SKILL.md` の名前・説明・パス）、`LUNA.md` と `MEMORY.md` の全文、そのセッションの一時ディレクトリのパスをこの順に連結してシステムプロンプトとする。

- 作業エージェントは `LUNA.md` と `MEMORY.md` を読み込まず、タスクに必要な時に自分で読む。
- skillの本文、日次記憶 `memory/YYYY-MM-DD.md`、トピック記憶 `memory/topics/*.md` は事前に読み込まず、エージェントが必要な時に読む。
- 開発者指示は会話・イベント実行・作業エージェントの種類ごとに固定で、`src/runtime/session-instructions.ts` が組み立てる。Home Assistantの接続や `[voice]` を設定した場合は、その使い方を加える。

## 実行と失敗

- モデルへの各リクエストには `request_timeout_ms` を適用する。
- 一時的な失敗（HTTP 5xx、接続の失敗・切断、タイムアウト）は、15秒・60秒・180秒待って最大3回、同じセッションの続きから再実行する。待機中に届いた割り込み入力は、再実行の前に入る。使用枠の上限到達（HTTP 429 の `usage_limit_reached`、`claude-code` の超過課金の拒否）、認証の失敗、それ以外の失敗は再実行しない。
- 成功した応答に提供元の障害の診断情報（WebSocketが使えずSSEで送り直した等）が付いていたら、warnログ `agent.pi.provider_diagnostic` に種類・詳細・エラーメッセージを記録する。障害を伴わない診断情報（`claude-code` の再生用の状態や使用枠の状態）は記録しない。
- 直近のリクエストの入力トークン数がモデルの文脈長から予約分（16384トークン）を引いた値を超えたら、`[models.compaction]` のモデルで古い部分を要約し、以後のリクエストでは「システムプロンプト、要約、直近の約20000トークン分」を送る。
- セッションの記録は [SPEC.md](./SPEC.md) の「記録の保持」のとおり追記する。

## 認証と使用枠

- ChatGPTの資格情報は `LUNA_HOME/auth/credentials.json`（ディレクトリは0700、ファイルは0600）に保存する。`luna-chat login` を実行すると、デバイスコード方式でログインして保存する。表示されたコードを任意の端末のブラウザで入力する。
- アクセストークンは期限の5分前からリクエストの直前に更新する。更新に失敗した実行は再試行せずに失敗とし、エラーログを記録する。次に実行が成功するまで、ダッシュボードに再ログインが必要であることを示す。
- 使用枠は起動時と以後10分ごとに取得し、`LUNA_HOME/state/usage.json` に書き出してダッシュボードに表示する。書き出す内容は `UsageSnapshot`（取得時刻、プラン、limitごとのprimary・secondaryウィンドウの使用率・長さ・リセット時刻）とする。
- `claude-code` は、Lunaのプロセスと同じユーザーで `claude`（Claude Code CLI）がPATHにあることを前提とする。Claude Codeの設定ディレクトリには `LUNA_HOME/claude-code` を使い（`CLAUDE_CONFIG_DIR`）、ログインは `CLAUDE_CONFIG_DIR=$LUNA_HOME/claude-code claude auth login` で行う。エージェントがシェルから使う `claude` には渡さず、そちらは通常の設定ディレクトリを使う。資格情報はClaude Codeが持ち、Lunaは読まない。`ANTHROPIC_API_KEY` はClaude Codeへ渡さず、認証や接続先を差し替える環境変数（`ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_BASE_URL`・Bedrock・Vertex・Foundry）があればリクエストを失敗とする。未インストール・未ログインもその実行の失敗とし、ダッシュボードの認証状態（ChatGPTのもの）は変えない。
- `claude-code` の応答がプランの枠ではなく超過課金（usage credits）に回されたら、その実行を失敗にして以後のリクエストを止める。Anthropicが超過課金を求めて拒否した場合も同じ。使用枠の取得と表示、高速モード（[voice.md](./voice.md)）は `openai-codex` だけが対象である。

## 再生

`luna-chat replay --scenes <file> --out <ディレクトリ> <名前>=<ディレクトリ>...` は、記録した入力を会話の指示で再生し、指示の違いによる振る舞いを比べる。ルナが自分の人格や記憶の変更案を確かめるのにも使う。

- 場面ファイルはJSONの配列で、各場面は `{ id, note?, inputs: [{ kind, text }] }`。`inputs` は会話の記録の `luna_input` と同じ形で、1回の実行に渡す入力の列とする。
- 位置引数の指示の組（`<名前>=<ディレクトリ>`）ごとに、そのディレクトリの `LUNA.md` と `MEMORY.md` を、会話と同じ開発者指示と現在のワークスペースのskill一覧に連結してシステムプロンプトとする。指示の組は1つ以上、名前は重複不可。
- モデルは `[models.conversation]`、リクエストのタイムアウトは `request_timeout_ms` を使う。資格情報は通常の実行と同じものを使う。
- ツールは会話と同じものを渡すが、外へ作用させない。Discordへの投稿・編集・削除・リアクション、会話の委任、タスクの作成・指示・取消、Assistへの返答は呼び出しを記録して成功を返す。Home Assistantのツールは渡さない。`exec_command`・`write_stdin`・`stop_background`・`edit`・`write`・`image_gen` は実行せずに記録して成功を返す。`read`・`view_image`・`web_run` は実際に実行する。Discordの履歴の読み取りは空を返す。
- 1つの場面でツール呼び出しが12回に達したら、その場面の実行を打ち切る。
- 出力先に、全結果の `results.json`（場面・指示の組・終了状態・ツール呼び出しの列）、場面ごとに候補の並びを無作為に入れ替えて A, B… と名付けた `blind.json`、その対応の `blind-key.json` を書く。再生の会話記録は残さない。

## 内部設計

### セッション

- `PiAgentRuntime` は `AgentRuntimePort` を実装し、`open(spec)` ごとに pi の `Agent` を作る。pi-ai の `Models`（提供元と資格情報ストア）は全セッションで共有する。
- `sessionId`（openai-codex の `prompt_cache_key` と WebSocket の接続キー）はセッションごとに固定し、キャッシュを効かせる。

### 失敗と再試行

- pi の Agent は自動では再試行せず、既定ではタイムアウトも持たない。`streamFn` を包んで `request_timeout_ms` と `maxRetries: 0` を渡す。
- 失敗の種類は、pi のエラー文字列ではなく、レスポンスのHTTPステータスとプロバイダの生のイベントで判定する。一時的な失敗は、エラーで終わったアシスタントメッセージを記録から外して `continue()` で再開する。待機中の steer はキューに残る。

### 圧縮と記録

- 圧縮の切り口と要約は pi-coding-agent の `findCutPoint` と `generateSummaryWithUsage` で作り、アダプターが保持する。`transformContext` で毎回のリクエストを「システム → 要約 → 切り口以降」に置き換え、記録（`agent.state.messages`）は書き換えない。
- 記録は `message_end` ごとにJSONLへ追記する。先頭の system メッセージは `message_end` で出ないため、開いた時点で書く。
- 記録の削除は、長く開いているセッションが開いた日のファイルに追記し続けるため、日付ではなく更新時刻で判断する。

### 認証と使用枠

- 資格情報は自前の `CredentialStore`（ファイル、0600、一時ファイルからの rename、プロバイダごとの直列化）に保存する。トークンの更新は pi-ai がリクエストの直前に行う。
- ChatGPTのバックエンド（`wham/usage`、`codex/alpha/search`、`codex/images/generations`）は、同じ資格情報で直接呼ぶ。

### Claude Code プロバイダ

```text
PiAgentSession ─► Models.streamSimple ─► claude-code provider
                                            │ 履歴を stream-json のフレームにして stdin へ
                                            ▼
                                   claude -p（子プロセス, --max-turns 1）
                                            │ ANTHROPIC_BASE_URL=ループバックの中継
                                            ▼
                                   TurnRelay ─► api.anthropic.com（1ターンに1リクエストだけ通す）
                                            │ SSE をそのまま捕まえて pi のイベントへ
                                            ▼
                                   AssistantMessage（ツール呼び出しは Luna が実行）
```

- `adapters/outbound/pi/claude-code/` は earendil-works/pi-claude-code（d5b5e04、MIT、`LICENSE` を同梱）の移植である。npm に公開されておらず、Git からの導入はしない方針のため取り込んだ。上流の修正を手で追えるよう、構造と関数名は上流に合わせてある。上流から外したのは Windows 対応、`PI_CLAUDE_CODE_*` の環境変数、モデルの探索、超過課金を許す設定。
- `CLAUDE_CONFIG_DIR` はプロセスの環境変数に入れず、ログイン状態の確認とリクエストの子プロセスにだけ重ねる。シェルのツールの子プロセスへ伝えないため。
- Claude Code にはツールを実行させない。ツールの一覧は、呼ばれても拒否だけを返す MCP サーバーとして見せ、モデルが出したツール呼び出しは中継で捕まえた応答から取り出す。MCP サーバーはバンドル後に `import.meta.url` からファイルを探せないため、文字列で持って一時ディレクトリへ書き出して起動する。
- 中継は Claude Code が足した user メッセージのリマインダを捨て、pi の履歴の内容で組み直す。履歴と合わなければ推測で送らずに失敗にする。
- Claude Code が画像と文書の合計サイズの上限で古い画像を間引いた要求（`[media removed: request limit.` の注記がある要求）では、間引かれた画像を履歴から戻さず、注記に置き換わった画像は注記のまま、跡なく消えた画像は落として送る。
- 同じセッションの直線的な続き（直前の応答にツール呼び出しがない）は、起動済みのプロセスを再利用する。保持は最大2つ・5分まで。それ以外は新しいプロセスで履歴全体を再生する。
- `keepSpareClaudeProcess(sessionId)` で登録したセッション（音声モードの表）は、毎回の要求が続きにならない前提で、起動済みの予備プロセスを1つ控える。予備は再利用の枠に入れず、会話の温まったプロセスを追い出さない。起動の条件の指紋が違えば予備を捨てて起動し直し、5分で入れ替える。予備の起動の失敗は報告せず、次の要求が自分で起動して失敗を返す。
- 応答のネイティブの内容（署名付きの思考を含む）は assistant メッセージの diagnostics（`claude-code.native-assistant.v1`）に載せ、次の再生で使う。そのぶんセッションの記録が大きくなる。
- モデルの一覧は静的で、pi-ai の anthropic のカタログから写し、料金は0にする。文脈長（1M）と最大出力（128K）は、Max のアカウントで Claude Code が報告する値と一致する。
- `rate_limit_event` の `isUsingOverage` が立った応答と、超過課金を求める拒否は「Claude Code billing」で始まるエラーにし、`classifyAgentError` が `usage_limit` に分類する。

### モデルの応答のストリーム

`ModelStreamPort` は、システムプロンプトとツールの定義を固定した `ModelStream` を開き、1つの user 文ごとに本文の差分とツール呼び出しを流す。ツールは実行せず、記録・圧縮・再試行もしない。音声モードの表が使う。実装の `PiModelStreams` は、`claude-code` のモデルで開くと `keepSpareClaudeProcess` を登録する。

### 再生

- `luna-chat replay` は、常駐プロセスとは別のプロセスで `PiAgentRuntime` を作り、場面ごと・指示の組ごとにセッションを開いて閉じる。会話の開発者指示は常駐側と同じものを使う。
- Lunaのツールは本物の定義を、ポートだけ記録用の偽物に差し替えて組み立てる。
- 記録は一時ディレクトリへ書き、終了時に消す。本物の会話記録に混ぜると、ルナが次に記録を見直す時に再生を本物の会話と取り違えるため。
