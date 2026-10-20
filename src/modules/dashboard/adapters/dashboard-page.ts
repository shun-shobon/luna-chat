// クライアントJSのバックスラッシュをそのまま残すためString.rawを使う。埋め込み式と区別できるよう、
// ページ内のJSではテンプレートリテラルを使わない。
export const DASHBOARD_PAGE_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luna ダッシュボード</title>
<style>
:root {
	color-scheme: light;
	--bg: #f4f5f8;
	--surface: #ffffff;
	--surface-2: #f0f1f5;
	--border: #e1e3ea;
	--text: #1c1f2a;
	--muted: #6a7083;
	--accent: #4b55c8;
	--accent-soft: #e7e9fb;
	--ok: #1f8a5b;
	--ok-soft: #dff3e9;
	--busy: #2f6fd6;
	--busy-soft: #e0ebfb;
	--wait: #a86a00;
	--wait-soft: #fbf0d9;
	--bad: #c23b3b;
	--bad-soft: #fbe3e3;
	--idle: #7b8194;
	--idle-soft: #eceef3;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--bg: #0f1117;
		--surface: #171a23;
		--surface-2: #1e222d;
		--border: #2a2f3c;
		--text: #e6e8ef;
		--muted: #9097a8;
		--accent: #9aa3ff;
		--accent-soft: #252a4a;
		--ok: #5fd39c;
		--ok-soft: #173327;
		--busy: #7fb0ff;
		--busy-soft: #1a2a45;
		--wait: #f0bc5e;
		--wait-soft: #3a2d14;
		--bad: #ff8a8a;
		--bad-soft: #3d1c1f;
		--idle: #8a90a2;
		--idle-soft: #232733;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.wrap { max-width: 1280px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 14px; }
header h1 { margin: 0; font-size: 20px; letter-spacing: 0.02em; }
header .meta { color: var(--muted); font-size: 12px; margin-left: auto; display: flex; gap: 10px; flex-wrap: wrap; }
.headline {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 12px;
	padding: 14px 16px;
	font-size: 15px;
	margin-bottom: 14px;
}
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px; }
.kpi .label { color: var(--muted); font-size: 12px; }
.kpi .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi .sub { color: var(--muted); font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 14px; }
.wide { grid-column: 1 / -1; }
section.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; min-width: 0; }
section.panel > h2 { margin: 0 0 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
section.panel > h2 .count { color: var(--muted); font-weight: 400; }
.empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
.list { display: flex; flex-direction: column; gap: 8px; }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; background: var(--surface-2); min-width: 0; }
.card .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.card .title { font-weight: 600; overflow-wrap: anywhere; }
.card .facts { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 12px; margin-top: 4px; }
.card .facts b { color: var(--text); font-weight: 500; }
.mono { font-family: var(--mono); font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 1px 9px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.s-ok { color: var(--ok); background: var(--ok-soft); }
.s-busy { color: var(--busy); background: var(--busy-soft); }
.s-wait { color: var(--wait); background: var(--wait-soft); }
.s-bad { color: var(--bad); background: var(--bad-soft); }
.s-idle { color: var(--idle); background: var(--idle-soft); }
.s-busy.pulse::before { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .s-busy.pulse::before { animation: none; } }
button.link { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; font-size: 12px; }
details > summary { cursor: pointer; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
.task-body, .log-body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.block { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.block.code { font-family: var(--mono); font-size: 12px; max-height: 420px; overflow: auto; }
.sublabel { color: var(--muted); font-size: 12px; }
.report { display: flex; flex-direction: column; gap: 3px; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-left: auto; font-weight: 400; }
.toolbar select, .toolbar input {
	background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
	padding: 4px 8px; font: inherit; font-size: 12px;
}
.toolbar input { width: 200px; max-width: 100%; }
.chip { display: inline-flex; gap: 6px; align-items: center; background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 1px 4px 1px 10px; font-size: 12px; }
.chip button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; }
.log { border-bottom: 1px solid var(--border); padding: 6px 2px; }
.log:last-child { border-bottom: 0; }
.log summary { display: grid; grid-template-columns: 70px 10px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.log .time { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.log .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); align-self: center; }
.log .dot.warn { background: var(--wait); }
.log .dot.error { background: var(--bad); }
.log .what { min-width: 0; }
.log .name { font-weight: 500; }
.log .ctx { color: var(--muted); font-size: 12px; margin-left: 6px; overflow-wrap: anywhere; }
.log .snippet { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sched { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; }
.status-error { color: var(--bad); }
</style>
</head>
<body>
<div class="wrap">
	<header>
		<h1>🌙 Luna</h1>
		<span id="agent-badge" class="badge s-idle">読み込み中</span>
		<div class="meta"><span id="uptime"></span><span id="updated"></span></div>
	</header>
	<div class="headline" id="headline">状態を読み込んでいます…</div>
	<div class="kpis" id="kpis"></div>
	<main class="grid">
		<section class="panel"><h2>会話セッション <span class="count" id="conversations-count"></span></h2><div id="conversations" class="list"></div></section>
		<section class="panel"><h2>イベント実行 <span class="count" id="events-count"></span></h2><div id="events" class="list"></div></section>
		<section class="panel wide"><h2>タスクボード <span class="count" id="tasks-count"></span></h2><div id="tasks" class="list"></div></section>
		<section class="panel wide"><h2>オートメーション</h2><div id="automation" class="list"></div></section>
		<section class="panel wide">
			<h2>最近の出来事 <span class="count" id="activity-count"></span>
				<span class="toolbar">
					<span id="session-filter"></span>
					<select id="level-filter" aria-label="レベル">
						<option value="all">すべて</option>
						<option value="warn">警告以上</option>
						<option value="error">エラーのみ</option>
					</select>
					<input id="text-filter" type="search" placeholder="絞り込み（本文・ID）" aria-label="絞り込み">
				</span>
			</h2>
			<div id="activity"></div>
		</section>
	</main>
</div>
<script>
(function () {
	"use strict";

	var POLL_MS = 3000;
	var ACTIVITY_LIMIT = 200;
	var state = {
		snapshot: null,
		error: null,
		lastOkAt: 0,
		open: new Set(),
		level: "all",
		text: "",
		session: null
	};

	var PHASES = {
		collecting: ["入力の待ち合わせ", "s-wait"],
		opening: ["スレッド準備中", "s-busy"],
		starting: ["ターン開始中", "s-busy"],
		turn: ["考え中", "s-busy"],
		retry_wait: ["再試行待ち", "s-bad"],
		effects: ["行動中", "s-busy"],
		orphaned_effects: ["後始末中", "s-wait"],
		idle: ["待機中", "s-idle"],
		archiving: ["終了処理中", "s-wait"]
	};
	var EVENT_PHASES = {
		opening: ["スレッド準備中", "s-busy"],
		turn: ["考え中", "s-busy"],
		retry_wait: ["再試行待ち", "s-bad"],
		effects: ["行動中", "s-busy"]
	};
	var TASK_STATUS = {
		running: ["作業中", "s-busy", 0],
		waiting_input: ["返答待ち", "s-wait", 1],
		queued: ["順番待ち", "s-idle", 2],
		failed: ["失敗", "s-bad", 3],
		completed: ["完了", "s-ok", 3],
		cancelled: ["取消", "s-idle", 3]
	};
	var REPORT_KIND = {
		progress: ["進捗", "s-idle"],
		milestone: ["節目", "s-busy"],
		question: ["質問", "s-wait"],
		result: ["結果", "s-ok"],
		failure: ["失敗", "s-bad"]
	};
	var AGENT_STATE = {
		ready: ["Codex 接続中", "s-ok"],
		starting: ["Codex 起動中", "s-wait"],
		restarting: ["Codex 再起動中", "s-bad"],
		fatal: ["Codex 停止（再起動上限）", "s-bad"],
		closed: ["Codex 終了", "s-idle"]
	};
	var EVENT_TYPES = {
		"system.heartbeat.fired.v1": "ハートビート",
		"system.schedule.fired.v1": "スケジュール",
		"system.memory_maintenance.fired.v1": "日次整理",
		"luna.task.reported.v1": "タスク報告の受け取り"
	};
	var LOG_LABELS = {
		"application.started": "起動完了",
		"application.shutdown_started": "終了開始",
		"application.shutdown_completed": "終了完了",
		"conversation.message_accepted": "メッセージ受信",
		"conversation.thread_opened": "会話スレッドを開始",
		"conversation.turn_started": "会話のターン開始",
		"conversation.turn_completed": "会話のターン完了",
		"conversation.effects_started": "会話で行動開始",
		"conversation.effect_settled": "行動の結果",
		"conversation.effects_settled": "会話の行動が完了",
		"conversation.thread_archived": "会話セッション終了",
		"conversation.operation_failed": "会話の処理に失敗",
		"event.execution_started": "イベント実行開始",
		"event.effects_started": "イベントで行動開始",
		"event.effects_settled": "イベントの行動が完了",
		"event.execution_completed": "イベント実行完了",
		"event.execution_failed": "イベント実行に失敗",
		"event.turn_retry_scheduled": "イベントのターン再試行",
		"task.turn_retry_scheduled": "タスクのターン再試行",
		"task.run_failed": "タスク実行に失敗",
		"task.run_interrupted": "タスク中断",
		"task.steer_skipped": "タスクへの追加指示を次のターンへ",
		"task.delivery_failed": "タスク報告の配送に失敗",
		"task.delivery_rejected": "タスク報告の配送を拒否",
		"discord.mcp_tool_started": "Discordツール呼び出し",
		"discord.mcp_tool_completed": "Discordツール完了",
		"discord.mcp_tool_failed": "Discordツール失敗",
		"agent.connection_failed": "Codex接続障害",
		"agent.restart_budget_exceeded": "Codex再起動上限",
		"agent.rpc_failed": "Codex RPCエラー",
		"automation.schedule.check_skipped": "スケジュールのcheckで見送り",
		"automation.schedule.check_failed": "スケジュールのcheck失敗"
	};

	function h(tag, attrs) {
		var el = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (key) {
				var value = attrs[key];
				if (value == null || value === false) return;
				if (key === "class") el.className = value;
				else if (key === "text") el.textContent = value;
				else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
				else el.setAttribute(key, value === true ? "" : String(value));
			});
		}
		for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
		return el;
	}
	function append(el, child) {
		if (child == null || child === false) return;
		if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
		el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
	}
	function replace(id, children) {
		var el = document.getElementById(id);
		el.replaceChildren();
		append(el, children);
	}
	function badge(pair, pulse) {
		return h("span", { class: "badge " + pair[1] + (pulse ? " pulse" : ""), text: pair[0] });
	}
	function fact(label, value) {
		return h("span", null, label + " ", h("b", { text: value }));
	}
	function empty(text) { return h("div", { class: "empty", text: text }); }
	function truncate(text, max) { return text.length > max ? text.slice(0, max) + "…" : text; }

	function duration(ms) {
		var s = Math.max(0, Math.floor(ms / 1000));
		var d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
		if (d > 0) return d + "日" + hr + "時間";
		if (hr > 0) return hr + "時間" + m + "分";
		if (m > 0) return m + "分" + sec + "秒";
		return sec + "秒";
	}
	function clock(iso) {
		var date = new Date(iso);
		var now = new Date();
		var time = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		if (date.toDateString() === now.toDateString()) return time;
		return (date.getMonth() + 1) + "/" + date.getDate() + " " + time.slice(0, 5);
	}
	function since(iso, suffix) {
		return h("span", { "data-since": iso, "data-suffix": suffix || "", text: duration(Date.now() - Date.parse(iso)) + (suffix || "") });
	}
	function until(iso) {
		return h("span", { "data-until": iso, text: untilText(iso) });
	}
	function untilText(iso) {
		var ms = Date.parse(iso) - Date.now();
		return ms <= 0 ? "まもなく" : "あと" + duration(ms);
	}
	function tick() {
		document.querySelectorAll("[data-since]").forEach(function (el) {
			el.textContent = duration(Date.now() - Date.parse(el.getAttribute("data-since"))) + el.getAttribute("data-suffix");
		});
		document.querySelectorAll("[data-until]").forEach(function (el) {
			el.textContent = untilText(el.getAttribute("data-until"));
		});
		if (state.lastOkAt > 0) {
			var age = Date.now() - state.lastOkAt;
			var updated = document.getElementById("updated");
			updated.textContent = state.error ? "更新失敗（" + state.error + "）・" + duration(age) + "前の状態" : "更新 " + duration(age) + "前";
			updated.className = state.error ? "status-error" : "";
		}
	}

	function keepOpen(details, key) {
		details.open = state.open.has(key);
		details.addEventListener("toggle", function () {
			if (details.open) state.open.add(key); else state.open.delete(key);
		});
		return details;
	}
	function parseJson(text) {
		if (text == null) return undefined;
		try { return JSON.parse(text); } catch (error) { return undefined; }
	}
	function pretty(text) {
		var value = parseJson(text);
		return value === undefined ? text : JSON.stringify(value, null, 2);
	}

	function sessionLabel(key, context) {
		if (context && typeof context === "object") {
			if (context.kind === "dm") return "DM";
			if (context.kind === "guild_thread") return "スレッド " + context.threadId;
			if (context.kind === "guild_channel") return "チャンネル " + context.channelId;
		}
		if (key.indexOf("http:") === 0) return "HTTP " + key.slice(5);
		return key;
	}
	function isActivePhase(phase) {
		return phase !== "idle" && phase !== "collecting";
	}
	function eventLabel(event) {
		var label = EVENT_TYPES[event.eventType];
		if (label === undefined && event.eventSource === "http") label = "HTTPイベント";
		if (label === undefined) label = event.eventType;
		return event.subject ? label + "（" + event.subject + "）" : label;
	}

	function renderHeader(s) {
		var agent = AGENT_STATE[s.agent.state] || [s.agent.state, "s-idle"];
		var el = document.getElementById("agent-badge");
		el.className = "badge " + agent[1];
		el.textContent = agent[0];
		el.title = s.agent.lastFailure ? "直近の障害: " + clock(s.agent.lastFailure.at) + " " + s.agent.lastFailure.message : "";
		replace("uptime", ["起動から ", since(s.startedAt)]);
	}

	function renderHeadline(s) {
		var parts = [];
		if (s.agent.state !== "ready") parts.push((AGENT_STATE[s.agent.state] || [s.agent.state])[0] + "のため、新しい思考を始められません");
		var thinking = s.conversations.filter(function (c) { return isActivePhase(c.phase); });
		var memory = thinking.filter(function (c) { return c.purpose === "session_memory"; });
		if (thinking.length - memory.length > 0) parts.push((thinking.length - memory.length) + "件の会話に応答中");
		if (memory.length > 0) parts.push(memory.length + "件の会話の記憶を保存中");
		var collecting = s.conversations.filter(function (c) { return c.phase === "collecting"; });
		if (collecting.length > 0) parts.push(collecting.length + "件の会話で入力を待ち合わせ中");
		if (s.events.length > 0) parts.push(s.events.map(eventLabel).join("・") + "を実行中");
		var working = s.tasks.tasks.filter(function (t) { return t.status === "running"; }).length;
		var waiting = s.tasks.tasks.filter(function (t) { return t.status === "waiting_input"; }).length;
		var queued = s.tasks.tasks.filter(function (t) { return t.status === "queued"; }).length;
		if (working > 0) parts.push("タスク" + working + "件を作業中");
		if (waiting > 0) parts.push("タスク" + waiting + "件で返答待ち");
		if (queued > 0) parts.push("タスク" + queued + "件が順番待ち");
		var text = parts.length > 0 ? "いまのルナ: " + parts.join("、") + "。" : "いまのルナ: 静かに待機しています。";
		var children = [text];
		if (s.automation.heartbeat.nextFireAt) children.push(h("span", { class: "sublabel" }, "　次のハートビートは ", until(s.automation.heartbeat.nextFireAt)));
		replace("headline", children);
	}

	function renderKpis(s) {
		var activeConversations = s.conversations.filter(function (c) { return isActivePhase(c.phase); }).length;
		var hourAgo = Date.now() - 3600000;
		var errors = s.activity.filter(function (r) { return r.level === "error" && Date.parse(r.timestamp) >= hourAgo; }).length;
		var openTasks = s.tasks.tasks.filter(function (t) { return TASK_STATUS[t.status] && TASK_STATUS[t.status][2] < 3; }).length;
		var heartbeat = s.automation.heartbeat;
		replace("kpis", [
			kpi("会話セッション", String(s.conversations.length), "応答中 " + activeConversations),
			kpi("イベント実行中", String(s.events.length), s.events.length > 0 ? truncate(s.events.map(eventLabel).join("・"), 40) : "なし"),
			kpi("タスク実行枠", s.tasks.running + " / " + s.tasks.maxConcurrent, "未完了 " + openTasks + "件"),
			kpi("次のハートビート", heartbeat.nextFireAt ? until(heartbeat.nextFireAt) : (heartbeat.enabled ? "実行中" : "無効"), heartbeat.nextFireAt ? clock(heartbeat.nextFireAt) : ""),
			kpi("エラー（1時間）", String(errors), "Codex再起動 " + s.agent.restartsInWindow + " / " + s.agent.restartLimit)
		]);
	}
	function kpi(label, value, sub) {
		return h("div", { class: "kpi" }, h("div", { class: "label", text: label }), h("div", { class: "value" }, value), h("div", { class: "sub", text: sub }));
	}

	function renderConversations(s) {
		document.getElementById("conversations-count").textContent = s.conversations.length + "件";
		var order = function (c) { return isActivePhase(c.phase) ? 0 : c.phase === "collecting" ? 1 : 2; };
		var items = s.conversations.slice().sort(function (a, b) { return order(a) - order(b) || a.key.localeCompare(b.key); });
		replace("conversations", items.length === 0 ? empty("開いている会話はありません") : items.map(function (c) {
			var phase = PHASES[c.phase] || [c.phase, "s-idle"];
			if (c.purpose === "session_memory" && isActivePhase(c.phase)) phase = ["記憶を保存中", "s-busy"];
			var facts = [h("span", null, "この状態 ", h("b", null, since(c.phaseSince)))];
			if (c.queuedEvents > 0) facts.push(fact("未処理", c.queuedEvents + "件"));
			if (c.retries > 0) facts.push(fact("再試行", c.retries + "回目"));
			if (c.idleDeadlineAt) facts.push(h("span", null, "終了まで ", h("b", null, until(c.idleDeadlineAt))));
			if (c.modelSettings) facts.push(fact("モデル", c.modelSettings.model + " / " + c.modelSettings.effort));
			return h("div", { class: "card" },
				h("div", { class: "top" },
					h("span", { class: "title", text: sessionLabel(c.key, c.context) }),
					badge(phase, phase[1] === "s-busy"),
					h("button", { class: "link", text: "出来事を見る", onclick: function () { setSession(c.key); } })),
				h("div", { class: "facts" }, facts),
				h("div", { class: "mono", text: c.key + (c.threadId ? " · thread " + c.threadId : "") + (c.turnId ? " · turn " + c.turnId : "") }));
		}));
	}

	function renderEvents(s) {
		document.getElementById("events-count").textContent = s.events.length + "件";
		replace("events", s.events.length === 0 ? empty("実行中のイベントはありません") : s.events.map(function (e) {
			var phase = EVENT_PHASES[e.phase] || [e.phase, "s-busy"];
			return h("div", { class: "card" },
				h("div", { class: "top" }, h("span", { class: "title", text: eventLabel(e) }), badge(phase, phase[1] === "s-busy")),
				h("div", { class: "facts" }, h("span", null, "経過 ", h("b", null, since(e.startedAt))), fact("開始", clock(e.startedAt))),
				h("div", { class: "mono", text: e.eventType + " · " + e.eventId + (e.threadId ? " · thread " + e.threadId : "") }));
		}));
	}

	function originLabel(origin) {
		if (origin.kind === "conversation") return sessionLabel(origin.session.key, origin.session.context);
		return EVENT_TYPES[origin.eventType] || origin.eventType;
	}

	function renderTasks(s) {
		var tasks = s.tasks.tasks.slice().sort(function (a, b) {
			var rank = function (t) { return TASK_STATUS[t.status] ? TASK_STATUS[t.status][2] : 9; };
			return rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
		});
		document.getElementById("tasks-count").textContent = "実行枠 " + s.tasks.running + " / " + s.tasks.maxConcurrent + " · 直近" + tasks.length + "件";
		replace("tasks", tasks.length === 0 ? empty("直近24時間のタスクはありません") : tasks.map(renderTask));
	}
	function renderTask(t) {
		var status = TASK_STATUS[t.status] || [t.status, "s-idle"];
		var latest = t.reports.length > 0 ? t.reports[t.reports.length - 1] : null;
		var pending = t.messages.filter(function (m) { return m.deliveredAt == null; }).length;
		var facts = [fact("依頼元", originLabel(t.origin)), fact("試行", String(t.attempts)), h("span", null, "更新 ", h("b", null, since(t.updatedAt, "前")))];
		if (pending > 0) facts.push(fact("未配送の追加指示", pending + "件"));
		if (t.private) facts.push(h("span", { text: "非公開" }));
		var summary = h("summary", null,
			h("div", { class: "top" }, badge(status, status[1] === "s-busy"), h("span", { class: "title", text: t.title })),
			h("div", { class: "facts" }, facts),
			latest ? h("div", { class: "facts" }, badge(REPORT_KIND[latest.kind] || [latest.kind, "s-idle"]), h("span", { text: truncate(latest.summary, 200) })) : null);
		var body = h("div", { class: "task-body" },
			h("div", { class: "sublabel", text: "指示" }), h("div", { class: "block", text: t.instructions }),
			t.outcome ? [h("div", { class: "sublabel", text: "結末" }), h("div", { class: "block", text: t.outcome })] : null,
			t.reports.length > 0 ? [h("div", { class: "sublabel", text: "報告（" + t.reports.length + "件）" }), t.reports.slice().reverse().map(function (r) {
				return h("div", { class: "block report" },
					h("div", { class: "top" }, badge(REPORT_KIND[r.kind] || [r.kind, "s-idle"]), h("span", { class: "mono", text: "#" + r.seq + " " + clock(r.reportedAt) + (r.deliveredAt ? "" : " · 未配送") })),
					h("div", { text: r.summary }),
					r.artifacts.length > 0 ? h("div", { class: "mono", text: r.artifacts.join("\n") }) : null);
			})] : null,
			t.messages.length > 0 ? [h("div", { class: "sublabel", text: "追加指示（" + t.messages.length + "件）" }), t.messages.map(function (m) {
				return h("div", { class: "block" }, h("div", { class: "mono", text: clock(m.receivedAt) + (m.deliveredAt ? "" : " · 未配送") }), m.text);
			})] : null,
			h("div", { class: "mono", text: t.id }));
		return keepOpen(h("details", { class: "card" }, summary, body), "task:" + t.id);
	}

	function renderAutomation(s) {
		var a = s.automation;
		var running = function (type) { return s.events.some(function (e) { return e.eventType === type; }); };
		var heartbeatFacts = [];
		if (!a.heartbeat.enabled) heartbeatFacts.push(h("span", { text: "無効" }));
		else if (a.heartbeat.nextFireAt) heartbeatFacts.push(h("span", null, "次回 ", h("b", null, until(a.heartbeat.nextFireAt)), "（" + clock(a.heartbeat.nextFireAt) + "）"));
		else heartbeatFacts.push(h("span", { text: "実行中（完了後に次回を抽選）" }));
		var cards = [
			h("div", { class: "card" },
				h("div", { class: "top" }, h("span", { class: "title", text: "ハートビート" }), running("system.heartbeat.fired.v1") ? badge(["実行中", "s-busy"], true) : null),
				h("div", { class: "facts" }, heartbeatFacts)),
			h("div", { class: "card" },
				h("div", { class: "top" }, h("span", { class: "title", text: "日次整理" }), running("system.memory_maintenance.fired.v1") ? badge(["実行中", "s-busy"], true) : null),
				h("div", { class: "facts" }, a.memoryMaintenance.enabled ? [fact("cron", a.memoryMaintenance.cron), a.memoryMaintenance.nextFireAt ? h("span", null, "次回 ", h("b", null, until(a.memoryMaintenance.nextFireAt)), "（" + clock(a.memoryMaintenance.nextFireAt) + "）") : null] : h("span", { text: "無効" })))
		];
		var jobs = a.schedule.slice().sort(function (x, y) { return (x.nextFireAt ? Date.parse(x.nextFireAt) : Infinity) - (y.nextFireAt ? Date.parse(y.nextFireAt) : Infinity); });
		cards.push(h("div", { class: "card" },
			h("div", { class: "top" }, h("span", { class: "title", text: "スケジュール（" + jobs.length + "件）" })),
			jobs.length === 0 ? empty("登録されたジョブはありません") : h("div", { class: "list" }, jobs.map(function (job) {
				var isRunning = s.events.some(function (e) { return e.eventType === "system.schedule.fired.v1" && e.subject === job.id; });
				var details = h("details", null,
					h("summary", null, h("div", { class: "sched" },
						h("span", null, h("b", { text: job.id }), " ", h("span", { class: "mono", text: job.kind === "recurring" ? job.cron : "1回のみ" }), job.check ? h("span", { class: "mono", text: " · checkあり" }) : null, isRunning ? [" ", badge(["実行中", "s-busy"], true)] : null),
						h("span", { class: "sublabel" }, job.nextFireAt ? [until(job.nextFireAt), "（" + clock(job.nextFireAt) + "）"] : "—"))),
					h("div", { class: "task-body" },
						h("div", { class: "block", text: job.prompt }),
						job.check ? h("div", { class: "block code", text: job.check }) : null));
				return keepOpen(details, "job:" + job.id);
			}))));
		replace("automation", h("div", { class: "grid" }, cards));
	}

	function contextChips(record) {
		var c = record.context || {};
		var parts = [];
		if (c.conversationSession) parts.push(c.conversationSession);
		if (c.taskId) parts.push("task " + c.taskId.slice(0, 8));
		if (c.jobId) parts.push("job " + c.jobId);
		if (c.eventId) parts.push("event " + c.eventId.slice(0, 8));
		return parts.join(" · ");
	}
	function pickText(value) {
		if (value == null || typeof value !== "object") return null;
		var keys = ["content", "summary", "brief", "title", "text", "prompt"];
		for (var i = 0; i < keys.length; i++) if (typeof value[keys[i]] === "string" && value[keys[i]] !== "") return value[keys[i]];
		return null;
	}
	function snippet(record) {
		var payload = parseJson(record.payload);
		var details = parseJson(record.details);
		if (record.event === "conversation.message_accepted" && payload && typeof payload === "object") {
			var author = payload.author ? (payload.author.displayName || payload.author.username) : "";
			return author + ": " + (payload.content || "（本文なし）");
		}
		if (Array.isArray(payload)) {
			var items = payload.map(function (item) {
				if (item == null || typeof item !== "object") return null;
				var text = pickText(item.input) || pickText(item.value) || item.error || null;
				var name = item.type || "";
				return text ? name + " " + text : name;
			}).filter(Boolean);
			if (items.length > 0) return items.join(" / ");
		}
		if (details && typeof details === "object") {
			if (details.error && typeof details.error === "object" && details.error.message) return details.error.message;
			if (typeof details.error === "string") return details.error;
			var text = pickText(payload);
			if (text) return text;
			return Object.keys(details).filter(function (k) { var v = details[k]; return v != null && typeof v !== "object"; })
				.map(function (k) { return k + "=" + details[k]; }).join(" ");
		}
		return pickText(payload) || "";
	}

	function renderActivity(s) {
		var levelRank = { info: 0, warn: 1, error: 2 };
		var minRank = state.level === "error" ? 2 : state.level === "warn" ? 1 : 0;
		var text = state.text.toLowerCase();
		var records = s.activity.filter(function (r) {
			if ((levelRank[r.level] || 0) < minRank) return false;
			if (state.session && (r.context || {}).conversationSession !== state.session) return false;
			if (text && (r.event + " " + JSON.stringify(r.context) + " " + (r.details || "") + " " + (r.payload || "")).toLowerCase().indexOf(text) < 0) return false;
			return true;
		}).reverse();
		document.getElementById("activity-count").textContent = records.length + " / " + s.activity.length + "件";
		replace("session-filter", state.session ? h("span", { class: "chip" }, sessionLabel(state.session, null), h("button", { "aria-label": "絞り込みを解除", text: "×", onclick: function () { setSession(null); } })) : null);
		replace("activity", records.length === 0 ? empty("該当する出来事はありません") : records.slice(0, ACTIVITY_LIMIT).map(function (r) {
			var label = LOG_LABELS[r.event] || r.event;
			var details = h("details", { class: "log" },
				h("summary", null,
					h("span", { class: "time", text: clock(r.timestamp) }),
					h("span", { class: "dot " + r.level }),
					h("div", { class: "what" },
						h("div", null, h("span", { class: "name", text: label }), h("span", { class: "ctx", text: contextChips(r) })),
						h("div", { class: "snippet", text: snippet(r) }))),
				h("div", { class: "log-body" },
					h("div", { class: "mono", text: r.event + " · " + r.timestamp }),
					Object.keys(r.context || {}).length > 0 ? h("div", { class: "block code", text: JSON.stringify(r.context, null, 2) }) : null,
					r.details ? [h("div", { class: "sublabel", text: "詳細" }), h("div", { class: "block code", text: pretty(r.details) })] : null,
					r.payload ? [h("div", { class: "sublabel", text: "本文" }), h("div", { class: "block code", text: pretty(r.payload) })] : null));
			return keepOpen(details, "log:" + r.seq);
		}));
	}

	function setSession(key) {
		state.session = key;
		if (state.snapshot) renderActivity(state.snapshot);
		if (key) document.getElementById("activity").scrollIntoView({ behavior: "smooth", block: "start" });
	}

	function render() {
		var s = state.snapshot;
		if (!s) return;
		renderHeader(s);
		renderHeadline(s);
		renderKpis(s);
		renderConversations(s);
		renderEvents(s);
		renderTasks(s);
		renderAutomation(s);
		renderActivity(s);
		tick();
	}

	var timer = null;
	var inFlight = false;
	function poll() {
		if (inFlight) return;
		inFlight = true;
		clearTimeout(timer);
		fetch("api/snapshot", { cache: "no-store" })
			.then(function (response) {
				if (!response.ok) throw new Error("HTTP " + response.status);
				return response.json();
			})
			.then(function (snapshot) {
				state.snapshot = snapshot;
				state.error = null;
				state.lastOkAt = Date.now();
				render();
			})
			.catch(function (error) {
				state.error = error && error.message ? error.message : String(error);
				if (!state.snapshot) document.getElementById("headline").textContent = "状態を取得できません: " + state.error;
				tick();
			})
			.finally(function () {
				inFlight = false;
				if (!document.hidden) timer = setTimeout(poll, POLL_MS);
			});
	}

	document.getElementById("level-filter").addEventListener("change", function (event) {
		state.level = event.target.value;
		if (state.snapshot) renderActivity(state.snapshot);
	});
	document.getElementById("text-filter").addEventListener("input", function (event) {
		state.text = event.target.value;
		if (state.snapshot) renderActivity(state.snapshot);
	});
	document.addEventListener("visibilitychange", function () {
		if (!document.hidden) poll();
	});
	setInterval(tick, 1000);
	poll();
})();
</script>
</body>
</html>
`;
