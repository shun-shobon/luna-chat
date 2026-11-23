# Home Assistant 連携

Home Assistant（以下HA）の状態の取得と操作、状態変化をきっかけにした実行、Assistの会話エージェントとしての応答を定める。

## 有効にする条件

環境変数 `HOME_ASSISTANT_URL` と `HOME_ASSISTANT_TOKEN` を両方指定すると、ツール・WebSocket接続・状態変化をきっかけにした実行が有効になる。片方だけの指定は起動を中止する。Assistの会話エージェントはHAへの接続を使わないため、指定の有無にかかわらず受け付ける。

HAのトークンを持つユーザーの権限で、すべてのドメイン・サービス・エンティティを操作できる。呼べるサービスや対象の制限、実行前の確認は設けない。トークンは `DISCORD_BOT_TOKEN` と違い、シェルツールとcheckの子プロセスにも渡す。

## ツール

会話・イベント実行・作業エージェントのすべてに渡す。HAへのリクエストはREST API（`/api/...`）に `Authorization: Bearer <トークン>` を付けて送り、15秒でタイムアウトする。HAが2xx以外を返した場合と、タイムアウト・接続の失敗は、HAの応答本文（あれば）を含めたツールの失敗とする。

| ツール             | 入力                                                                                            | 結果                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ha_list_entities` | `{ domain?, area?, name?, entity_ids?: string[], max?: 1以上の整数 }`                           | `{ entities: [{ entity_id, state, friendly_name, area?, device? }], total, truncated }`                                |
| `ha_get_state`     | `{ entity_id }`                                                                                 | HAの状態オブジェクト（`entity_id`、`state`、`attributes`、`last_changed`、`last_updated`）。存在しなければツールの失敗 |
| `ha_list_services` | `{ domain? }`                                                                                   | `[{ domain, services: { <サービス名>: { description?, fields: { <フィールド名>: 説明 } } } }]`                         |
| `ha_call_service`  | `{ domain, service, entity_id?: string \| string[], data?: object, return_response?: boolean }` | `{ changed_states: [{ entity_id, state }], service_response? }`                                                        |

- `domain` と `service` は `^[a-z0-9_]+$`、`entity_id` は `^[a-z0-9_]+\.[a-z0-9_]+$` に合わなければ検証エラーとする。
- `ha_list_entities` は `entity_ids`（指定時は他の条件より優先）、`domain`（完全一致）、`area`、`name`（`entity_id` か `friendly_name` に大文字小文字を区別せず含む）の順に絞り込み、`max`（省略時200）件までを返す。`total` は絞り込み後の件数、`truncated` は `max` で切ったかどうか。各要素は属性を含めない。
- `area` を指定した場合だけ、WebSocket APIでエリア・デバイス・エンティティの登録情報を取得し、エンティティのエリア（エンティティ自身のエリア、なければデバイスのエリア）の名前かIDが一致するものを残す。このとき各要素に `area` と `device`（デバイス名）を付ける。登録情報は5分間キャッシュし、WebSocketが接続していなければツールの失敗とする。
- `ha_call_service` は `data` に `entity_id` を加えた本文を `POST /api/services/<domain>/<service>` に送る。`return_response` が真ならクエリ `?return_response` を付け、HAが返す `service_response` を結果に含める。

## WebSocket接続

起動時に `HOME_ASSISTANT_URL` から導いた `ws(s)://.../api/websocket` へ接続し、`auth_required` に対してトークンで認証してから、`state_changed` イベントを購読する。

- 30秒ごとに `ping` を送り、10秒以内に `pong` がなければ切断して再接続する。
- 切断・認証の失敗・接続の失敗では、5秒・10秒・30秒・60秒（以後60秒）待って再接続する。認証が成功したら待ち時間を最初に戻す。切断中に起きた状態変化は補完しない。
- 接続・切断・認証の失敗はログ（`home_assistant.ws.*`）に記録し、状態をダッシュボードに示す。

## 状態変化をきっかけにした実行

ワークスペースの `home-assistant.toml` に、どのエンティティの状態変化でルナを起動するかを書く。エージェントが自分で編集する。ファイルがなければ何も起動しない。

```toml
watch = ["binary_sensor.front_door", "climate.*"]
ignore = ["sensor.*_battery"]
cooldown_seconds = 30 # 省略時30
```

- `watch` と `ignore` は `entity_id` のパターンの配列（省略時は空）。`*` は任意の文字列（`.` を含む）に一致し、それ以外の文字は完全一致とする。`cooldown_seconds` は0以上の数。
- 状態変化を受けるたびにファイルの更新時刻を確かめ、変わっていれば読み直す（再起動は不要）。不正なファイルはその更新時刻につき1回だけエラーログ `home_assistant.watch_config_invalid` を記録し、何も起動しないものとして扱う。
- 次をすべて満たす状態変化を起動の対象とする: 変化前と変化後の状態がどちらもある、`state` の値が変わった（属性だけの変化は対象外）、`watch` のいずれかに一致し `ignore` のどれにも一致しない、同じエンティティの前回の起動から `cooldown_seconds` 以上経った。前回の起動時刻はメモリ上に持ち、再起動で消える。
- 対象の状態変化は `home_assistant.state_changed.v1` イベント（`source: "home_assistant"`、`subject` はエンティティID、`occurredAt` は変化後の `last_changed`、`data` は `{ entity_id, friendly_name, old_state, new_state, unit, device_class }`。値がない項目は `null`）として、キー `home_assistant:state_changes` の会話セッションへ渡す。入力の種類は `home_assistant_state`。集約・割り込み入力・アイドル終了・セッション記憶保存はDiscordの会話と同じとし、初回履歴は空とする。

## Assistの会話エージェント

HAのカスタム統合 [ha-luna](https://github.com/shun-shobon/ha-luna) を入れると、HAのAssist（音声・テキスト）で会話エージェントとしてLunaを選べる。統合はHTTP API（[http-api.md](./http-api.md) と同じサーバー）の `POST /home-assistant/conversation` を呼ぶ。HAとLunaが別のホストにある場合は `LUNA_HTTP_HOST=0.0.0.0` が必要で、認証は行わない。

```ts
type AssistRequest = {
	text: string; // 1文字以上
	language: string;
	conversation_id: string; // 1〜128文字
	device_id: string | null;
	satellite_id: string | null;
	device_name: string | null;
	area_name: string | null;
	user_name: string | null;
};
type AssistResponse = { speech: string | null; continue_conversation: boolean };
```

- 受け付けた発話は `home_assistant.assist.requested.v1` イベント（`source: "home_assistant"`、`id` はリクエストID、`data` はリクエスト本文）として会話セッションへ渡す。入力の種類は `assist_request`。
- 会話セッションは `device_id` があれば端末ごと（キー `home_assistant:assist:device:<device_id>`）、なければHAの会話IDごと（キー `home_assistant:assist:conversation:<conversation_id>`）とする。集約の待機（`debounce_ms`）は行わず、受け付けたらすぐに実行する。それ以外（割り込み入力・アイドル終了・セッション記憶保存）はDiscordの会話と同じとし、初回履歴は空とする。
- エージェントは `assist_respond`（入力 `{ request_id: string, speech: string(1〜2000文字), continue_conversation?: boolean }`、省略時 `false`）で読み上げる文を返す。呼ばれた時点でHTTPの応答を返し、実行は続く。同じリクエストIDへの2回目以降、応答待ちでないリクエストIDへの呼び出しはツールの失敗とする。`assist_respond` は会話とイベント実行に渡す。
- `assist_respond` がないまま実行が正常に終わったら `200 {"speech":null,"continue_conversation":false}`、実行が失敗したら `500 {"error":"execution_failed"}` を返す。
- JSON形式が不正またはスキーマに合わない入力は `400 {"error":"invalid_request"}`、JSON以外のContent-Typeは `415`、受付停止中は `503 {"error":"unavailable"}` を返す。シャットダウン時に応答待ちのリクエストには `500 {"error":"execution_failed"}` を返す。

## 内部設計

```text
HA REST ◄── HomeAssistantRestClient ◄── ha_* ツール
HA WebSocket ◄─► HomeAssistantConnection ──state_changed──► StateChangeWatcher ──accept──► ConversationCoordinator
                     ▲ 登録情報（area 指定時）               │ home-assistant.toml（更新時刻で読み直し）
                     └──── ha_list_entities                  ▼ cooldown（メモリ）
ha-luna ──POST /home-assistant/conversation──► AssistService ──accept──► ConversationCoordinator（集約なし）
        ◄──────────── speech ──────────────── AssistResponseRegistry ◄── assist_respond ツール
```

- `HomeAssistantConnection` は1本のWebSocketで認証・購読・ping・再接続を担い、`id` で応答を対応づける要求（登録情報の取得）も同じ接続で送る。
- `home-assistant.toml` は更新時刻が変わった時だけ読み直す。`state_changed` がセンサーの数だけ頻繁に届くため、毎回のファイル読みを避ける。
- Assistの会話の集約の待機をなくすため、`ConversationCoordinator` は `isImmediate(event)` が真の入力で debounce と入力中の待機を飛ばす。
- `AssistResponseRegistry` は `assist_respond` の時点で応答待ちのPromiseを解決する。`http_respond` と違い実行の完了を待たないのは、音声の応答待ちを縮め、返答の後も実行を続けられるようにするため。実行の完了は `onBatchSettled` で受け、未応答なら `speech: null` または失敗で解決する。
- ルートはHTTPイベントAPIと同じHonoアプリに加える。
