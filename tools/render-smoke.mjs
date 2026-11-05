#!/usr/bin/env node
/**
 * 客户端 bundle 冒烟渲染：不启动 DSH、不用浏览器。
 *
 * 用一套最小 React 垫片把 lib/client.js 里的组件函数真的跑一遍，
 * 用来抓「点开面板就白屏」这类低级错误（拼错函数、undefined 调用、props 用错）。
 * 它不验证布局与交互，只验证渲染路径不会抛异常。
 *
 * 运行：node tools/render-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "lib/client.js"), "utf8");

// ── 最小 React 垫片 ────────────────────────────────────────────────────────
let hookIndex = 0;
let stateIndex = 0;
/** 当前组件被强制注入的 useState 初始值（按 useState 调用顺序）。 */
let forcedStates = null;
/** 组件 → 强制 state 列表。 */
const forcedByComponent = new Map();
const react = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children };
	},
	useState(initial) {
		const fallback = typeof initial === "function" ? initial() : initial;
		const value = forcedStates !== null && stateIndex < forcedStates.length ? forcedStates[stateIndex] : fallback;
		stateIndex += 1;
		return [value, () => {}];
	},
	useEffect() {},
	useMemo(factory) {
		return factory();
	},
	useRef() {
		return { current: null };
	},
	useSyncExternalStore(_subscribe, getSnapshot) {
		const snapshot = getSnapshot();
		return snapshot.open === false ? { open: true } : snapshot;
	},
	useCallback: (fn) => fn
};

// ── 最小 DOM 垫片（只为 insertStyles 与 window.addEventListener 存在）─────
const document = {
	head: { appendChild: () => {} },
	createElement: () => ({ dataset: {}, textContent: "" }),
	documentElement: {}
};
const window = {
	addEventListener: () => {},
	removeEventListener: () => {},
	__ModuleLoader__: {}
};

let exported = null;
window.__ModuleLoader__.load = ({ id, factory }) => {
	if (id !== "dsh-client-ui-token-usage") throw new Error("注册 id 不对：" + id);
	exported = factory((name) => {
		if (name === "react") return react;
		throw new Error("意外的 require：" + name);
	}, { async: () => Promise.reject(new Error("smoke: 不加载 chunk")) });
};

const sandbox = {
	window,
	document,
	require: undefined,
	console,
	Intl,
	Date,
	Math,
	Number,
	String,
	Array,
	Object,
	JSON,
	Promise,
	setTimeout,
	clearTimeout,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	fetch: () => Promise.reject(new Error("smoke: 不联网"))
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "lib/client.js" });

if (exported === null) throw new Error("client bundle 没有完成注册");
if (typeof exported.apply !== "function") throw new Error("bundle 没有导出 apply");

// ── 假 ctx：捕获 slot 组件 ────────────────────────────────────────────────
const slots = new Map();
const ctx = {
	locale: { bind: () => (key) => key, register: () => () => {} },
	effect: (fn) => {
		fn();
		return () => {};
	},
	slots: {
		inject: (_name, register) => register(),
		register: (options, component) => {
			slots.set(options.name + "#" + options.id, component);
			return () => {};
		}
	}
};

exported.apply(ctx);

const button = slots.get("sidebar.footer.action#token-usage");
const dock = slots.get("shell.overlay#token-usage");
if (button === undefined) throw new Error("没有注册 sidebar.footer.action");
if (dock === undefined) throw new Error("没有注册 shell.overlay");

// ── 极简递归渲染：把函数组件一路展开，遇到 DOM 元素就停 ───────────────────
const MAX_DEPTH = 40;
let rendered = 0;
/** 渲染过程中按函数名登记组件，方便后续单独再渲染一次。 */
const byName = new Map();

function renderNode(node, depth) {
	if (depth > MAX_DEPTH) throw new Error("渲染层数过深，可能有组件自递归");
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) renderNode(child, depth);
		return;
	}
	if (typeof node === "string" || typeof node === "number") return;
	if (typeof node !== "object") return;
	if (typeof node.type === "function") {
		rendered += 1;
		if (node.type.name) byName.set(node.type.name, node.type);
		hookIndex = 0;
		stateIndex = 0;
		forcedStates = forcedByComponent.get(node.type) ?? null;
		const props = { ...node.props, children: node.children.length === 1 ? node.children[0] : node.children };
		const output = node.type(props);
		renderNode(output, depth + 1);
		return;
	}
	for (const child of node.children) renderNode(child, depth);
}

// 面板默认关闭，这里让 useSyncExternalStore 强制返回 open=true，渲染内部结构。
renderNode(react.createElement(button, { t: (key) => key, wide: true }), 0);
renderNode(react.createElement(dock, { t: (key) => key }), 0);

const emptyPass = rendered;

// ── 第二遍：注入有数据的 state，覆盖卡片 / 表格 / 设置抽屉的渲染路径 ──────
const now = Date.now();
const trend = Array.from({ length: 30 }, (_, index) => ({
	day: new Date(now - (29 - index) * 86400000).toISOString().slice(0, 10),
	requests: index * 3,
	input: index * 1000,
	cacheRead: index * 90000,
	output: index * 400,
	total: index * 91400,
	cost: index * 0.12
}));
const overview = {
	currency: "CNY",
	totals: { requests: 24457, input: 59497154, cacheRead: 4678724626, cacheWrite: 0, output: 17188627, total: 4755410407, cost: 329.5675, unpricedRows: 11062 },
	today: { requests: 5, tokens: 120345, cost: 0.4213 },
	hitRate: 0.9874,
	unpricedRows: 11062,
	failures: { error: 120, aborted: 8 },
	unpriced: [{ provider: "opencode-go", model: "deepseek-v4-flash", requests: 1633, tokens: 191065048 }],
	fx: { rate: 6.6854, date: "2026-11-05", source: "auto", provider: "open.er-api.com" },
	calendar: [{ year: 2025, days: 33, holidays: 27, overrides: 0 }, { year: 2026, days: 39, holidays: 31, overrides: 0 }],
	pricing: { entries: 6, priced: 6 },
	pricingError: null
};
const heat = trend.slice(-40).map((entry) => ({ day: entry.day, requests: entry.requests, total: entry.total, cost: entry.cost }));
const logs = {
	total: 24457,
	page: 1,
	pageSize: 50,
	rows: [
		{
			ts: now,
			provider: "opencode-go",
			model: "deepseek-flash",
			input: 1000,
			cacheRead: 9000,
			cacheWrite: 0,
			output: 100,
			total: 10100,
			ttft: 600,
			decode: 1000,
			speed: 100,
			peak: true,
			cost: 0.00316,
			costCurrency: "CNY",
			costCny: 0.00316,
			costUsd: 0.00047
		},
		{
			ts: now - 60000,
			provider: "unknown",
			model: "no-price-model",
			input: 500,
			cacheRead: 0,
			cacheWrite: 0,
			output: 50,
			total: 550,
			ttft: null,
			decode: null,
			speed: null,
			peak: false,
			cost: null,
			costCurrency: null,
			costCny: null,
			costUsd: null
		}
	]
};
const models = [{ provider: "opencode-go", model: "deepseek-flash", requests: 5731, tokens: 1449524933, lastTs: now, priced: true }];
const pricing = [
	{
		provider: "opencode-go",
		model: "deepseek-flash",
		currency: "CNY",
		unit: "per_1m",
		prices: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeakPrices: null,
		peakValley: { enabled: true, windows: [{ start: 540, end: 720, crosses: false }], windowsMean: "peak", discount: 0.5, weekend: "valley", holiday: "valley" }
	}
];
const calendar = overview.calendar;
const groups = [
	{ model: "deepseek-flash", requests: 5731, tokens: 1449524933, priced: true, variants: [{ provider: "opencode-go", model: "deepseek-flash", requests: 5731, tokens: 1449524933 }] },
	{
		model: "deepseek-v4.1-flash-fast",
		requests: 2715,
		tokens: 560879306,
		priced: false,
		variants: [
			{ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash-fast", requests: 2268, tokens: 478585277 },
			{ provider: "commandcode-bad", model: "deepseek/deepseek-v4.1-flash-fast", requests: 447, tokens: 82294029 }
		]
	}
];
const aliases = [{ alias: "deepseek-v4-flash", canonical: "deepseek-flash" }];

// UsageDock 的 useState 顺序：overview/trend/heat/logs/models/pricing/groups/aliases/calendar/range/page/filter/error/settingsOpen/revision/loading
forcedByComponent.set(dock, [overview, trend, heat, logs, models, pricing, groups, aliases, calendar, 30, 1, "", "", true, 0, false]);
rendered = 0;
renderNode(react.createElement(dock, { t: (key) => key }), 0);

const dataPass = rendered;

// ── 第三遍：设置抽屉里的两个弹窗（价格 / 别名）单独渲染一次 ──────────────
const settings = byName.get("SettingsSheet");
if (settings === undefined) throw new Error("没有渲染到 SettingsSheet");
const settingsProps = {
	tr: (key) => key,
	fx: overview.fx,
	pricing,
	groups,
	aliases,
	calendar,
	onClose: () => {},
	onSaveFx: () => {},
	onRefreshFx: () => {},
	onRefreshCalendar: () => {},
	onOverride: () => {},
	onSaveAlias: () => {},
	onRemoveAlias: () => {},
	onSavePricing: () => {},
	onRemovePricing: () => {}
};

let dialogRendered = 0;
for (const dialog of ["pricing", "aliases"]) {
	forcedByComponent.set(settings, ["6.67", "", "holiday", dialog, ""]);
	rendered = 0;
	renderNode(react.createElement(settings, settingsProps), 0);
	dialogRendered += rendered;
}

if (emptyPass < 8) throw new Error("空数据下只渲染了 " + emptyPass + " 个组件，面板内容可能没展开");
if (dataPass < 12) throw new Error("有数据下只渲染了 " + dataPass + " 个组件，列表/设置可能没渲染");
if (dialogRendered < 8) throw new Error("设置弹窗只渲染了 " + dialogRendered + " 个组件，价格/别名弹窗可能没打开");

console.log("render-smoke ok：空数据 " + emptyPass + " 个组件，有数据 " + dataPass + " 个组件，两个设置弹窗 " + dialogRendered + " 个组件，无异常。");
