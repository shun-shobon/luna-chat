# ボイスチャンネル

`config.toml` に `[voice]` を書くと、ルナがDiscordのボイスチャンネル（VC）に入り、人の発話を聞き取って会話できる。`[voice]` がなければ、この機能のツールは渡さない。

## 設定

```toml
[voice]
stt_model_kind = "nemo-ctc"
stt_model_dir = "/var/lib/luna/models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
vad_model = "/var/lib/luna/models/silero_vad.onnx"
stt_threads = 2
silence_ms = 300
turn_wait_ms = 500
unfinished_turn_wait_ms = 3000
interrupt_model = "openai/gpt-6-luna"
tts_engine = "voicevox"
tts_url = "http://127.0.0.1:10101/"
tts_speaker = 684965824
tts_speed = 1.0
```

- `stt_threads`・`silence_ms`・`turn_wait_ms`・`unfinished_turn_wait_ms`（いずれも1以上の整数）・`interrupt_model`・`tts_engine`・`tts_speed`（0.5〜2）は省略すると上の値になる。それ以外は必須で、TTSの項目は `tts_engine` に応じて変わる。
- `stt_model_kind` は `nemo-ctc`（Parakeet ja など）・`nemo-transducer`（Haas-ja など）・`transducer`（Zipformer など）・`sense-voice`（SenseVoice）のいずれかで、`stt_model_dir` は sherpa-onnx の配布形式のディレクトリとする（`tokens.txt` と各部品の `.onnx` を名前から探し、`int8`・`quantized` の版を優先する）。`sense-voice` には言語の手がかりとして日本語を渡す。モデルのファイルとディレクトリは起動時に読み込み、読めなければ起動を中止する。
- `tts_engine` は `voicevox`（VOICEVOX互換のHTTP API。AivisSpeech Engine など）か `speech-cpp`（speech.cpp の `speech serve` の OpenAI 互換API）とする。`tts_url` は `http` か `https` のURL とする。`voicevox` では `tts_speaker`（エンジンのスタイルID）を、`speech-cpp` では `tts_voice`（`speech serve --add-voice` で登録した声の名前）を必須とし、もう一方は書けない。`tts_emoji`（真偽値）は `speech-cpp` だけに書け、読み方の指示として絵文字を読むモデル（Irodori-TTS）で `true` にする。省略すると `false` になる。
- `interrupt_model` は割り込み判定に使う決定モデル（`provider/model`）で、`openai/gpt-6-luna`（OpenAIのDecisions API）か、TypeSafe の Jev（`typesafe/jev` など）を選べる。提供元のカタログにない、または提供元の鍵（`OPENAI_API_KEY`・`TYPESAFE_API_KEY`）がなければ起動を中止する。
- 音声モードの返事に使うモデルは `[models.voice]`（[SPEC.md](./SPEC.md) の設定）で選ぶ。

## 参加とモード

ルナは自分の判断で、ツールでVCに入り、モードを切り替え、出る。VCには同時に1つだけ入る。

| ツール         | 入力                                                                                                             | 内容                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice_join`   | `{ mode: "text" \| "voice", channel_id?: string, user_id?: string }`（`channel_id` と `user_id` のどちらか一方） | `channel_id` のVC、または `user_id` の人が今いるVCに入り、呼び出した会話のスコープに紐づける。入っているVCと同じなら、紐づけ先とモードだけを切り替える。別のVCに入っていれば、出てから入る。Discordの会話以外（イベント実行など）からの呼び出し、VCでないチャンネル、Botに接続または発言の権限がないVC、Botから見えるVCにいない人の指定はツールの失敗とする |
| `voice_leave`  | `{}`                                                                                                             | 入っているVCから出る。入っていなければツールの失敗とする                                                                                                                                                                                                                                                                                                    |
| `voice_report` | `{ text: string }`（1〜2000文字、前後の空白は除く）                                                              | 音声モードの依頼の結果を表に渡す。音声モードでないとき、または紐づいた会話以外から呼んだときはツールの失敗とする                                                                                                                                                                                                                                            |

- テキストモード: 確定した発話を紐づいた会話のルナに渡し、ルナは文字で返事をする（`send_message` など）。VCではルナを自分でミュートにし、話さないモードであることを見て分かるようにする。
- 音声モード: 速いモデル（`[models.voice]`、以下「表」）がルナとして声で返事をする。会話のルナ（以下「裏」）は、表から頼まれた調べ物や操作を担う。ミュートは外す。
- VCにいたBot以外の人が全員抜けたら、すぐに出る。Bot以外の人がいないVCに入った場合は60秒待ち、その間に誰も来なければ出る。シャットダウン時にも出る。
- 自分を含むBotの音声は聞き取らない。

## 会話セッションと入力

- VCの入力は、`voice_join` を呼んだ会話のスコープ（Guildチャンネル・スレッド・DM）の会話セッションへ渡す。そのスコープのセッションが終わっていれば、Discordの会話と同じく新しく開く。VCに入っている間、紐づいたスコープは一時セッションと同じく、常設でなくても投稿を受け付ける。
- 発話は `discord.voice.utterance.v1` の `LunaEvent`（入力の種類 `voice_utterance`）として渡す。`data` は `{ guild_id, channel_id, user_id, speaker, text, mode }` とし、`speaker` はサーバーでの表示名（取得できなければユーザーID）、`mode` はその時点のモードとする。テキストモードでは確定した発話をすべて渡し、音声モードでは裏への依頼の実行中に確定した発話だけを渡す。
- VCの入力（`voice_utterance`・`voice_delegation`・`voice_transcript`）は集約の待機（`debounce_ms`・`typing_idle_ms`）を行わず、すぐに渡す。実行中なら割り込み入力として渡す。それ以外（アイドル終了・セッション記憶保存・初回コンテキスト）はDiscordの会話と同じとする。
- 聞き取った内容と表の返事はテキストチャットに投稿しない。
- VCに紐づいている間、紐づいた会話セッションのLLMへのリクエストは高速モード（ChatGPTのFast、`service_tier: "priority"`）で送る。モデルが速く返す代わりに、使用枠の消費が増える。紐づけが外れた後のリクエストから通常に戻る。

## 聞き取りとターンの確定

- 話者ごとに、Discordの音声が `silence_ms` 途切れた時点で区切り、すぐに認識する。区切りはまだターンの終わりではない。受信中にVADが声を一度も検知しなかった区切りは捨て、ターンにつなげず確定の待ちもやり直さない。Discordは話し終わりに短い音を間を置いて送ってくるため。
- 区切った音声は、Silero VAD（`vad_model`）で声の区間を探し、前後0.2秒を残して区間だけをつなげて認識する。声の区間がなければ認識しない。無音や雑音からの誤認識を防ぐため。
- 認識は sherpa-onnx のオフライン認識器でLunaのプロセス内で行い、話者をまたいで1つずつ行う。`sense-voice` が笑い声・咳など声以外の音と判定した結果は、空の結果と同じく扱う。
- 区切りの後 `turn_wait_ms` の間に同じ話者の声がなければ、ターンを確定する。認識結果が接続助詞や言いよどみ（「〜けど」「〜から」「えっと」など）で終わり文が途中に見えるときは、`unfinished_turn_wait_ms` まで待つ。待っている間に同じ話者が話し始めたら確定を待たず、次の区切りで音声をつなげて最初から認識し直す。断片ごとの文字列をつなぐと境目で認識が崩れるため。
- 認識結果が空だった区切りは、そのターンに何も足さない。空の区切りしかない話者のターンは確定しない。
- 人がいるVCに後から入ると音声の復号に失敗し続けることがある（`@discordjs/voice` の既知の不具合）。復号の失敗が続き、最初の失敗から5秒間どの話者の音声も復号できなければ、同じVCに同じ紐づけとモードで入り直す。

## 音声モードの返事と割り込み

- 表には、`[models.voice]` のモデルに、表の指示・`LUNA.md`・`MEMORY.md` をシステムプロンプトとし、会話記録の直近40件と、何をきっかけに話すか（ターンの確定、または裏の報告）を1つのuser文として渡す。システムプロンプトは音声モードに入る時に組み立てる。表のツールは裏に頼む `delegate`（`{ request: string }`）だけとし、返事は普通のテキスト出力で返させる。出力が空なら黙る。要求のタイムアウトは30秒で、再試行しない。`tts_emoji` が `true` なら絵文字で声の感情や笑い・ため息を指示させ、`false` なら絵文字を書かせない。
- 会話記録は、聞き取った発話、ルナが実際に再生できた部分（再生し終えた文・途中で止めた文・再生しなかった文）、裏への依頼、裏の報告を時刻付きで持つ。音声モードの間だけメモリに持ち、古いものから300件を超えた分を捨てる。
- 表は区切りの時点で返事を作り始め、最初の区切りから合成も始める（先行生成）。再生はターンの確定後に始める。確定前に同じ話者の続きや別の話者の発話が来たら、作りかけを捨てて作り直す。確定前に表が出した `delegate` は確定してから裏に渡し、捨てた返事の `delegate` は渡さない。
- 返事は文末の記号（`。！？♪` と改行など）で区切り、最初の区切りだけは読点（`、`）でも切る。声に出す文字（かな・漢字・英数字）が3文字に満たない区切りは、短すぎて合成を断られることがあるので次の区切りとつなげる。
- 返事は区切りずつ、`tts_engine` のTTSエンジン（`tts_url`）で話速 `tts_speed` の48kHzに合成し、言った順に再生する。`voicevox` はスタイル `tts_speaker` の48kHzステレオで合成させる。`speech-cpp` は `POST /v1/audio/speech` に声 `tts_voice` と `response_format: "wav"` を送り、48kHz・16bitのモノラルなら左右に複製してステレオにする。`speech-cpp` は別のホストで動かす前提で、1区切りの合成を15秒で打ち切る。前の区切りの再生中に次の区切りを合成しておく。合成に失敗した区切りはログに残して飛ばす。表が失敗したら、それまでに出た区切りだけを再生する。
- 再生中に人の声をVADが検知しても、すぐには止めない。音量を下げて話し続け、その声が割り込みかを `interrupt_model` で判定する。
  1. 声が区切れた時点、または区切れる前に1秒続いた時点で、その声を認識する。
  2. 認識結果が空、または声以外の音なら雑音とみなす。
  3. それ以外は、認識結果と、そのときルナが読み上げていた文を渡し、「割り込み」「相づち」「ルナに向けていない発話」の3択で判定する。判定のタイムアウトは3秒で、再試行しない。認識と判定の失敗は割り込みとみなす。
  4. 割り込みなら、その時点で再生と表の要求を止めて返事を捨て、どこまで再生できたかを会話記録に残し、その声を通常の発話としてターンの確定に回す。相づちとルナに向けていない発話は会話記録にだけ残す。声が区切れて割り込みでないと決まったら音量を戻す。
- 待ち時間を区間ごとにinfoログに出す。`voice.segment.transcribed`（認識時間）、`voice.front.responded`（表の最初の文字までと全体の時間）、`voice.turn.latency`（話し終えてからターン確定まで、最初の文字まで、最初の合成まで、話し終えてから声が出るまで、先行生成の有無）、`voice.interrupt.judged`（判定の結果と認識・判定の時間）。

## 裏への依頼と報告

- 表が `delegate` を呼ぶと、`discord.voice.delegated.v1` の `LunaEvent`（入力の種類 `voice_delegation`）を紐づいた会話へ渡す。`data` は `{ guild_id, channel_id, request, transcript }` とし、`transcript` は裏へまだ渡していない会話記録である。各要素は `type`（`heard`・`said`・`delegated`・`report`）と時刻 `at` を持つ。
- 依頼を渡した実行が終わるまで、音声モードで確定した発話も `voice_utterance` として渡す。
- 裏は `voice_report` で結果を返す。結果は会話記録に入り、すぐには読み上げない。誰も話しておらず、ターンの確定待ちも割り込みの判定もなく、表も話していない時に、表が伝えるかどうか決める。リンクや長い詳細は、裏が会話のテキストチャットに投稿する。
- 退出やテキストモードへの切り替えで音声モードを終える時、裏へまだ渡していない会話記録に発話か返事があれば、`discord.voice.transcript.v1` の `LunaEvent`（入力の種類 `voice_transcript`、`data` は `{ guild_id, channel_id, transcript }`）として紐づいた会話へ渡す。セッション記憶保存で音声の会話も振り返れるようにするため。

## 内部設計

```text
voice_join / voice_leave / voice_report ──► VoiceChannelService ──connect──► DiscordVoiceGateway ──► @discordjs/voice
                                               │  ▲                               │ 話者ごとの受信（Opus→16kHz）・区切り
                          onSegment / onSpeechStarted / onHumanCount / onClosed ◄─┘ 声の検知（Silero VAD）
                                               ▼
                                          TurnTracker ── 区切りをつなげて認識し直し、ターンを確定
                                               │ テキストモード: 確定 → voice_utterance
                                               │ 音声モード:
                                               ▼
   VoiceSession ── draft で先行生成、commit で再生 ──► VoiceResponder ──► ModelStream（表、[models.voice]）
      │  │  └─ 再生中の声 ──► InterruptJudge ──► InterruptClassifierPort（PiInterruptClassifier → pi-ai classify）
      │  └──► SpeechOutput ──► SpeechSynthesizerPort（AivisSpeech / speech.cpp） ──► VoiceLink.play（音量は VoiceLink.setVolume）
      └──► 裏: voice_delegation / voice_utterance / voice_transcript ──► ConversationCoordinator.accept
                         ▲ voice_report（会話のルナ）               onBatchSettled ──► 依頼の実行の終わり
```

- `VoiceChannelService` は入っているVC、紐づけ先の会話セッション、モードを持つ。参加・退出・切り替えは `SerialQueue` で順に行い、紐づけ先は `voice_join` を呼んだ実行の `ToolOrigin` から取る。
- `TurnTracker` は版番号で、古い認識結果が新しい区切りを上書きしないようにする。
- `VoiceSession` は返事（`Reply`）を同時に1つだけ持ち、`commit` が `draft` と同じ話者・同じ版なら再生を許し、違えば作り直す。人に聞こえ得た返事（`release` 済み）だけを、止めた時点の再生位置とともに会話記録に残す。
- `InterruptJudge` は、区切れて扱いが決まった後に遅れて返った途中の判定で結果を覆さない。
- 依頼の実行中かどうかは、`ConversationCoordinator` の `onBatchSettled` に依頼のイベントIDが来るまでとする。
- `DiscordVoiceLink` の再生は、Readable から1フレーム（20ms）ずつ音量を掛けて Opus 化し、先に作るフレームを2つに抑える。音量の変更をすぐ効かせるため。ミュートの切り替えは接続を張り直さず、Ready の接続への `rejoin` で音声の状態だけを送り直す。Opusの復号器がレートとチャンネル数を変換するので、自前のリサンプルは持たない。
- 声の合図には話者ごとの Silero VAD を使い、Discordの「話し始め」の通知は使わない。雑音でも届くため。
- `@discordjs/voice` は復号の失敗を `debug` のメッセージでしか知らせないため、接続を `debug: true` で作り、失敗のメッセージと受信できた音声から「失敗が続いている時間」を測って入り直す。入り直しは `DiscordVoiceLink` の中で行い、サービスの状態（紐づけとモード）は変えない。
- `SherpaTranscriber` は `decodeAsync` でイベントループを止めずに認識し、全話者で1つの `SerialQueue` を通してCPUの取り合いを避ける。`sherpa-onnx-node` は型定義を持たないので、使う範囲だけを `sherpa-onnx-node.d.ts` で宣言し、認識結果と VAD の区間はZodで検証する。
- `PiInterruptClassifier` は、OpenAI と TypeSafe のプロバイダだけを入れた専用の pi-ai `Models` で `classify` を呼ぶ。会話用の `Models` に入れると、それらのチャットモデルが `/luna model` の候補に混ざるため。
- `AivisSpeechSynthesizer` は AudioQuery の `speedScale` と出力形式だけを差し替え、ほかの項目はエンジンが返したまま送り返す。
- VCの入力の集約の待機をなくすため、`ConversationCoordinator` の `isImmediate(event)` はVCの3種類の入力に真を返す。
- 高速モードは `AgentSessionSpec.fastMode` をリクエストのたびに呼んで決め、真なら pi-ai の `onPayload` でリクエスト本文に `service_tier: "priority"` を足す（pi-ai の `streamSimple` は `serviceTier` を通さないため）。リクエストのたびに決めるので、セッションを開き直さずに参加・退出へ追従する。
- 紐づいたスコープへの投稿を常設でなくても受け付けるため、`DiscordConversationController` は `isVoiceBound(sessionKey)` を一時セッションの有無と同じ扱いで受付判定に渡す。
