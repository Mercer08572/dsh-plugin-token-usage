#!/usr/bin/env node
/**
 * 离线集成自检：不启动 DSH，用一个假的 ctx 把 Host 半边跑起来。
 *
 * 覆盖：建库 → 价格播种 → 事件落库（首字/速度/峰谷/成本）→ HTTP 接口返回。
 * 数据写在临时 HOME 下，不碰真实的 ~/.dsh/token-usage。
 *
 * 运行：node tools/selftest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "token-usage-test-"));
process.env.HOME = home;
mkdirSync(join(home, ".dsh"), { recursive: true });

const { apply } = await import("../lib/index.js");

const listeners = new Map();
const routes = new Map();
let backfillDone = false;

/** 假 sessionQuery：父会话 + 一个 fork 出来的子会话（子会话整段复制了父会话的前缀）。 */
const parentEvents = [
	{ type: "step/start", seq: 0, time: Date.parse("2026-11-05T09:30:00+08:00"), data: { turn: 1, step: 1 } },
	{
		type: "assistant/message",
		seq: 1,
		time: Date.parse("2026-11-05T09:30:02+08:00"),
		data: {
			turn: 1,
			step: 1,
			message: { role: "assistant", content: [], source: { kind: "model", provider: "opencode-go", model: "deepseek-flash" } },
			usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, totalTokens: 110 },
			stream: [{ type: "text-chunks", time0: Date.parse("2026-11-05T09:30:01+08:00"), index: 0, dt: [1, 1, 1] }]
		}
	}
];
const childEvents = [
	...parentEvents,
	{ type: "step/start", seq: 2, time: Date.parse("2026-11-07T09:30:00+08:00"), data: { turn: 2, step: 1 } },
	{
		type: "assistant/message",
		seq: 3,
		time: Date.parse("2026-11-07T09:30:02+08:00"),
		data: {
			turn: 2,
			step: 1,
			message: { role: "assistant", content: [], source: { kind: "model", provider: "opencode-go", model: "deepseek-flash" } },
			usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, totalTokens: 220 },
			stream: [{ type: "text-chunks", time0: Date.parse("2026-11-07T09:30:01+08:00"), index: 0, dt: [1, 1, 1] }]
		}
	}
];
const fakeQuery = {
	async listSessions() {
		return [
			{ header: { id: "session-child", createdAt: 1, cwd: "/tmp", isSeeded: true, parentSession: "session-parent" } },
			{ header: { id: "session-parent", createdAt: 0, cwd: "/tmp", isSeeded: false } }
		];
	},
	async readSession(id) {
		if (id === "session-parent") return { session: { id }, inheritedEventCount: 0, events: parentEvents };
		if (id === "session-child") return { session: { id }, inheritedEventCount: 2, events: childEvents };
		throw new Error("unknown session " + id);
	}
};

const ctx = {
	effect: (fn) => {
		const dispose = fn();
		return dispose;
	},
	on: (name, handler) => {
		listeners.set(name, handler);
		return () => listeners.delete(name);
	},
	inject: (_deps, callback) => {
		callback({ sessionQuery: fakeQuery });
		return { dispose: () => {} };
	},
	webServer: {
		register: (route) => {
			routes.set(route.path, route.handler);
			return () => routes.delete(route.path);
		}
	}
};

apply(ctx);

const emit = (sessionId, event) => {
	const handler = listeners.get("session/event");
	if (handler === undefined) throw new Error("没有注册 session/event 监听");
	handler({ id: sessionId }, event);
};

/** 构造一条贴近真实的 assistant/message（紧凑流 + 提供方用量）。 */
function messageEvent({ seq, stepStart, provider, model, input, cacheRead, output, ttft, decode }) {
	const stream = [{ type: "chunk", time: stepStart + 5, chunk: { type: "block-start", index: 0, blockType: "text" } }];
	const firstToken = stepStart + ttft;
	const perToken = Math.round(decode / 10);
	stream.push({ type: "text-chunks", time0: firstToken, index: 0, dt: new Array(10).fill(perToken), texts: new Array(10).fill("x") });
	return {
		type: "assistant/message",
		seq,
		time: firstToken + decode,
		data: {
			turn: 1,
			step: 1,
			message: { role: "assistant", content: [], source: { kind: "model", provider, model } },
			usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, totalTokens: input + cacheRead + output },
			stream
		}
	};
}

// 2026-11-05 09:30 北京时间 = 周四高峰段。
const stepStart = Date.parse("2026-11-05T09:30:00+08:00");
emit("session-test", { type: "step/start", seq: 0, time: stepStart, data: { turn: 1, step: 1 } });
emit(
	"session-test",
	messageEvent({ seq: 1, stepStart, provider: "opencode-go", model: "deepseek-flash", input: 1000, cacheRead: 9000, output: 100, ttft: 600, decode: 1000 })
);

// 2026-11-07 09:30 北京时间 = 周六，同一时钟区间应判为谷时（半价）。
const weekendStart = Date.parse("2026-11-07T09:30:00+08:00");
emit("session-test", { type: "step/start", seq: 2, time: weekendStart, data: { turn: 2, step: 2 } });
emit(
	"session-test",
	messageEvent({ seq: 3, stepStart: weekendStart, provider: "opencode-go", model: "deepseek-flash", input: 1000, cacheRead: 0, output: 0, ttft: 500, decode: 500 })
);

// 未定价模型：成本必须为空。
emit("session-test", { type: "step/start", seq: 4, time: stepStart, data: { turn: 3, step: 3 } });
emit(
	"session-test",
	messageEvent({ seq: 5, stepStart, provider: "unknown", model: "no-price-model", input: 500, cacheRead: 0, output: 50, ttft: 200, decode: 200 })
);

// 同一模型的另一种写法：不同 provider + vendor 前缀 + 大小写，应当命中同一条价格。
emit("session-test", { type: "step/start", seq: 8, time: stepStart, data: { turn: 4, step: 4 } });
emit(
	"session-test",
	messageEvent({ seq: 9, stepStart, provider: "vendor-x", model: "DeepSeek/DeepSeek-Flash", input: 1000, cacheRead: 0, output: 0, ttft: 100, decode: 100 })
);

// 一次失败尝试 + 一次取消。
emit("session-test", {
	type: "assistant/attempt",
	seq: 10,
	time: stepStart + 2000,
	data: { turn: 4, step: 4, stream: [{ type: "chunk", time: stepStart + 2000, chunk: { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT" } } } }] }
});
emit("session-test", { type: "assistant/attempt", seq: 7, time: stepStart + 3000, data: { turn: 5, step: 5, stream: [{ type: "chunk", time: stepStart + 3000, chunk: { type: "block-start" } }] } });

const handler = routes.get("/__token-usage");
if (handler === undefined) throw new Error("没有注册 /__token-usage");

/** 直接调用路由处理器，模拟浏览器 POST。 */
async function call(action, payload = {}) {
	const body = JSON.stringify({ action, ...payload });
	const req = {
		method: "POST",
		headers: { "x-token-usage-client": "1" },
		on(event, cb) {
			if (event === "data") cb(Buffer.from(body));
			if (event === "end") cb();
		}
	};
	let status = 0;
	let text = "";
	const res = {
		writeHead: (code) => {
			status = code;
		},
		end: (chunk) => {
			text = chunk;
		}
	};
	await handler(req, res);
	const parsed = JSON.parse(text);
	if (status !== 200 || parsed.ok !== true) throw new Error(`${action} 失败：${text}`);
	return parsed;
}

const failures = [];
const check = (condition, message) => {
	if (!condition) failures.push(message);
};

// 等后台回填跑完（读两个假会话，几乎立即）。
await new Promise((resolve) => setTimeout(resolve, 200));

const overview = await call("overview");
// 回填 2 条（子会话复制的前缀必须被指纹去重，否则是 3 条）+ 实时 3 条。
check(overview.totals.requests === 6, `请求数应为 6（2 回填 + 4 实时），实际 ${overview.totals.requests}`);
check(overview.backfill.done === true, "回填状态应标记完成");
check(overview.failures.error === 1, `失败数应为 1，实际 ${overview.failures.error}`);
check(overview.failures.aborted === 1, `取消数应为 1，实际 ${overview.failures.aborted}`);
check(overview.unpriced.length === 1, `未定价模型应只剩 1 个（no-price-model），实际 ${overview.unpriced.length}`);
check(overview.unpriced[0]?.model === "no-price-model", "未定价模型名应为归一化后的 no-price-model");

const logs = await call("logs");
const rows = logs.rows;
const peakRow = rows.find((row) => row.model === "deepseek-flash" && row.cacheRead === 9000);
const weekendRow = rows.find((row) => row.model === "deepseek-flash" && row.input === 1000 && row.output === 0 && row.cacheRead === 0 && row.ttft === 500);
const unpricedRow = rows.find((row) => row.model === "no-price-model");

check(peakRow !== undefined && peakRow.ttft === 600, `首字应为 600ms，实际 ${peakRow?.ttft}`);
check(peakRow !== undefined && Math.abs(peakRow.speed - 100) < 1, `速度应约为 100 tok/s，实际 ${peakRow?.speed}`);
check(peakRow?.peak === true, "09:30 周四应判为峰时");
check(weekendRow?.peak === false, "09:30 周六应判为谷时");
check(peakRow !== undefined && Math.abs(peakRow.cost - (1000 * 2 + 9000 * 0.04 + 100 * 8) / 1e6) < 1e-9, `峰值成本算错：${peakRow?.cost}`);
check(weekendRow !== undefined && Math.abs(weekendRow.cost - (1000 * 2 * 0.5) / 1e6) < 1e-9, `谷值成本算错：${weekendRow?.cost}`);
check(unpricedRow?.cost === null, "未定价模型的成本必须为 null");
const variantRow = rows.find((row) => row.model === "DeepSeek/DeepSeek-Flash");
check(variantRow !== undefined && Math.abs(variantRow.cost - 1000 * 2 / 1e6) < 1e-9, `vendor 前缀 + 大小写变体应命中同一条价格：${variantRow?.cost}`);

// 改价后：历史不动，新请求按新价。
await call("pricingSave", {
	entries: [{ provider: "*", model: "deepseek-flash", currency: "CNY", unit: "per_1m", prices: { input: 4, cacheRead: 0.08, cacheWrite: 0, output: 16 } }]
});
const stepStart2 = Date.parse("2026-11-05T10:00:00+08:00");
emit("session-test", { type: "step/start", seq: 14, time: stepStart2, data: { turn: 6, step: 6 } });
emit("session-test", messageEvent({ seq: 15, stepStart: stepStart2, provider: "opencode-go", model: "deepseek-flash", input: 1000, cacheRead: 0, output: 0, ttft: 150, decode: 100 }));
// 别名：把另一个写法映射到已定价的规范名。
await call("aliasSave", { alias: "deepseek-v4.9-flash", canonical: "deepseek-flash" });
const aliasStart = Date.parse("2026-11-05T10:30:00+08:00");
emit("session-test", { type: "step/start", seq: 16, time: aliasStart, data: { turn: 7, step: 7 } });
emit("session-test", messageEvent({ seq: 17, stepStart: aliasStart, provider: "vendor-y", model: "deepseek-v4.9-flash", input: 1000, cacheRead: 0, output: 0, ttft: 120, decode: 100 }));

const afterPrice = await call("logs", { pageSize: 20 });
const newest = afterPrice.rows.find((row) => row.ttft === 150);
check(newest !== undefined && Math.abs(newest.cost - 1000 * 4 / 1e6) < 1e-9, `改价后的新请求应按新价：${newest?.cost}`);
const aliased = afterPrice.rows.find((row) => row.ttft === 120);
check(aliased !== undefined && Math.abs(aliased.cost - 1000 * 4 / 1e6) < 1e-9, `别名应命中规范名的新价格：${aliased?.cost}`);
const history = afterPrice.rows.find((row) => row.ttft === 600);
check(history !== undefined && Math.abs(history.cost - 0.00316) < 1e-9, "历史成本不应被改价影响");

const trend = await call("trend", { days: 7 });
check(trend.days.length === 7, "趋势应为 7 天");
check(trend.days.some((day) => day.requests >= 3), "趋势里应有请求");

const heat = await call("heatmap", { weeks: 53 });
check(heat.days.length >= 2, "热力图应有数据");

const settings = await call("settingsGet");
check(settings.displayCurrency === "CNY", "默认币种应为 CNY");

if (failures.length > 0) {
	console.error("自检失败：");
	for (const failure of failures) console.error("  - " + failure);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}

console.log("selftest ok：");
console.log("  请求 6 条（2 回填 + 4 实时，fork 前缀已去重）/ 失败 1 / 取消 1 / 未定价 1");
console.log("  峰值成本", peakRow.cost, "谷值成本", weekendRow.cost);
console.log("  首字", peakRow.ttft, "ms / 速度", peakRow.speed.toFixed(1), "tok/s");
console.log("  改价后历史成本保持不变");
rmSync(home, { recursive: true, force: true });
