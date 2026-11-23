# HTTPイベントAPI

ローカルHTTPでイベントを受け付けるAPIと、その応答を返す `http_respond` ツールを定める。待ち受けアドレスとポートは [SPEC.md](./SPEC.md) の環境変数、認証がないことの影響は信頼境界の節にある。

## リクエスト

`POST /events` に `Content-Type: application/json` で以下のオブジェクトを送る。同じサーバーはAssistの会話エージェントの `POST /home-assistant/conversation`（[home-assistant.md](./home-assistant.md)）も受け付ける。その他のパスやメソッドは提供しない。

```ts
type HttpEventRequest =
	| {
			execution: "one_shot";
			response_mode: "async" | "wait";
			event: { type: string; data: JsonValue };
	  }
	| {
			execution: "conversation";
			response_mode: "async" | "wait";
			session_id: string; // 1〜128文字
			event: { type: string; data: JsonValue };
	  };
```

`one_shot` は新しいセッションで実行して終了時に閉じる。`conversation` は `session_id` ごとの会話セッションへ投入し、Discord会話と同じ集約・割り込み入力・アイドル終了を適用する。HTTP会話の初回履歴は空とする。`session_id` は `one_shot` では指定できない。

エージェントへは `http_request` 入力として渡す。`LunaEvent` の `data` は `{ payload: 送信されたevent.data, response_mode }` であり、IDと受信時刻はLunaが生成する。

## レスポンス

`async` は受付直後に `202 {"request_id":"..."}` を返し、結果取得用のAPIは設けない。`wait` は実行の終了まで接続を維持し、`http_respond` で指定されたHTTPステータスとJSON本文を返す。正常終了まで `http_respond` がなければ `204`、実行に失敗したら `500 {"error":"execution_failed","request_id":"..."}` を返す。

JSON形式が不正またはスキーマに合わない入力は `400`、JSON以外のContent-Typeは `415`、受付停止中は `503` を返す。受付処理自体の予期しない例外には `500 {"error":"internal_error"}` を返す。APIは認証、リクエストの再送・重複排除、処理待ちのアプリケーションタイムアウトを提供しない。クライアントが切断しても受理済みイベントの処理は続く。

## `http_respond`

入力は `{ request_id: string, status: number, body_json: string }` とし、`body_json` はJSONとしてパースできる文字列とする。

- 指定できるステータスは200〜599で、本文を持てない204、205、304を除く。
- HTTPレスポンスは、そのリクエストを渡した実行の完了後に確定する。ワンショット実行がバックグラウンド実行の終了を受けて続く場合も、続きの実行は待たない。
- 会話の複数イベントが同じ実行にまとまる場合も、`request_id` で各リクエストの応答先を指定する。
- 複数の `http_respond` が同じリクエストIDを指定した場合、最初の1件だけを受け付け、後続はツールの失敗とする。`async` のリクエストIDに対する `http_respond` もツールの失敗とする。

## 内部設計

- HTTPアダプターは `/events` のJSONをZodで検証し、`LunaEvent` を生成する。`one_shot` はEventExecutorへ、`conversation` は `http:<session_id>` の会話セッションへ直接渡す。受付停止中は503を返し、受理済みワンショット実行は終了時にdrainする。
- `http_respond` は `request_id` をキーにステータスとJSON本文を一時保存する。ワンショット実行の最初の実行、または会話の実行が完了した時点で、待機中のHTTPリクエストを解決する（EventExecutor の `afterFirstRun`）。会話側は実行に入れたイベントID（最初のバッチと steer したもの）を追跡し、実行の完了時に通知する。
