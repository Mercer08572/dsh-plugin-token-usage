#!/usr/bin/env node
/**
 * 离线回放：把 ~/.dsh/sessions 下已有的会话日志喂给 lib/core.js，
 * 用真实数据验证「事件 → 用量行 → 成本」的口径，不启动 DSH、不写数据库。
 *
 * 运行：node tools/replay.mjs [--limit N] [--verbose]
 *
 * 只做三件事：
 *   1. 解出多帧 zstd 日志（一帧 = 一次 append，标准库只认第一帧，这里自己拼）；
 *   2. 复用 core 的 buildUsageRow / buildAttemptRow，口径与线上完全一致；
 *   3. 打印总量、命中率、成本分布、首字/速度区间，方便和面板数字对账。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { buildAttemptRow, buildUsageRow, matchPricing, parsePricingFile } from "../lib/core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) || Infinity : Infinity;
const VERBOSE = args.includes("--verbose");

/** 拼接多帧 zstd：DSH 每次 append 写一帧，标准解压接口只吐第一帧。 */
function decodeLog(buffer) {
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const offsets = [];
	for (let index = 0; index < buffer.length - 4; index += 1) {
		if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) offsets.push(index);
	}
	const chunks = [];
	for (const offset of offsets) {
		try {
			chunks.push(zstdDecompressSync(buffer.subarray(offset)));
		} catch {
			/* 不是真正的帧头，跳过 */
		}
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * 收集会话日志文件，每个会话只保留**当前格式代际**。
 * 升级后会同时留下 `session.jsonl.zstd` / `session.v3...` / `session.v4...`，
 * 它们是同一份会话的不同代际，全读会重复计数；v4 是当前格式。
 */
function collectLogs() {
	const base = join(homedir(), ".dsh", "sessions");
	const best = new Map();
	let workspaces = [];
	try {
		workspaces = readdirSync(base);
	} catch {
		return [];
	}
	for (const workspace of workspaces) {
		const dir = join(base, workspace);
		if (!statSync(dir).isDirectory()) continue;
		for (const session of readdirSync(dir)) {
			const sessionDir = join(dir, session);
			if (!statSync(sessionDir).isDirectory()) continue;
			for (const name of readdirSync(sessionDir)) {
				if (!name.endsWith(".zstd")) continue;
				const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name);
				if (match === null) continue;
				const version = match[1] === undefined ? 0 : Number(match[1]);
				const file = join(sessionDir, name);
				const previous = best.get(session);
				if (previous === undefined || version > previous.version) best.set(session, { file, version });
			}
		}
	}
	return [...best.values()].map((entry) => entry.file).sort();
}

/** 载入价格文件。 */
function loadPricing() {
	const parsed = parsePricingFile(readFileSync(join(ROOT, "pricing.json"), "utf8"));
	return parsed.models;
}

/** 载入内置节假日表：返回 day → 'holiday' | 'workday' | 'normal'。 */
function loadCalendar() {
	const seed = JSON.parse(readFileSync(join(ROOT, "calendar.seed.json"), "utf8"));
	const map = new Map();
	for (const days of Object.values(seed.years)) {
		for (const day of days) map.set(day.date, day.off ? "holiday" : "workday");
	}
	return (day) => map.get(day) ?? "normal";
}

const pricing = loadPricing();
const calendar = loadCalendar();
const files = collectLogs().slice(0, LIMIT);

/** 读一个日志文件 → 事件数组（含 header）。 */
function readEvents(file) {
	let text;
	try {
		text = decodeLog(readFileSync(file));
	} catch {
		return null;
	}
	const events = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* 撕裂尾部 */
		}
	}
	return events.length === 0 ? null : events;
}

/**
 * fork 出来的会话会把父会话的前缀整段复制进自己的日志。用「事件指纹」判定重复：
 * 同一条历史事件在父子两份日志里 type / time / data 完全一致（seq 也一致，但不参与），
 * 而两次真实请求的时间戳不可能撞在同一毫秒。只对 assistant 事件做指纹，成本可控。
 */
function fingerprint(event) {
	return event.type + "|" + event.time + "|" + JSON.stringify(event.data);
}

const USAGE_TYPES = new Set(["assistant/message", "assistant/attempt"]);
const loaded = [];
for (const file of files) {
	const events = readEvents(file);
	if (events === null) continue;
	const header = events.find((event) => event.type === "session");
	if (header === undefined) continue;
	loaded.push({ file, sessionId: header.id, header, events });
}
const byId = new Map(loaded.map((entry) => [entry.sessionId, entry]));
const parentPrints = new Map();
for (const entry of loaded) {
	if (entry.header.isSeeded !== true || typeof entry.header.parentSession !== "string") continue;
	const parent = byId.get(entry.header.parentSession);
	if (parent === undefined) continue;
	const prints = new Set();
	for (const event of parent.events) if (USAGE_TYPES.has(event.type)) prints.add(fingerprint(event));
	parentPrints.set(entry.sessionId, prints);
}

const rows = [];
const attempts = [];
let sessions = 0;

for (const entry of loaded) {
	const { sessionId, events } = entry;
	const inherited = parentPrints.get(sessionId) ?? null;
	let stepStart = null;
	let seen = false;
	for (const event of events) {
		if (inherited !== null && USAGE_TYPES.has(event.type) && inherited.has(fingerprint(event))) continue;
		if (event.type === "step/start") {
			stepStart = event.time;
			continue;
		}
		if (event.type === "assistant/message") {
			seen = true;
			const row = buildUsageRow({
				sessionId,
				event,
				stepStartTime: stepStart,
				pricing: matchPricing(pricing, event.data?.message?.source?.provider, event.data?.message?.source?.model),
				calendar,
				fxRate: 7.1
			});
			if (row !== null) rows.push(row);
			continue;
		}
		if (event.type === "assistant/attempt") {
			const row = buildAttemptRow({ sessionId, event });
			if (row !== null) attempts.push(row);
		}
	}
	if (seen) sessions += 1;
}

const sum = (list, key) => list.reduce((total, row) => total + (row[key] ?? 0), 0);
const requests = rows.length;
const input = sum(rows, "input");
const cacheRead = sum(rows, "cacheRead");
const output = sum(rows, "output");
const total = sum(rows, "total");
const priced = rows.filter((row) => row.cost !== null);
const unpriced = rows.filter((row) => row.cost === null);
const costCny = priced.reduce((totalCost, row) => totalCost + (row.costCny ?? 0), 0);
const ttfts = rows.map((row) => row.ttft).filter((value) => value !== null);
const speeds = rows.map((row) => row.speed).filter((value) => value !== null && value > 0);
const peakRows = rows.filter((row) => row.peak).length;
const percentile = (list, ratio) => {
	if (list.length === 0) return 0;
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
};

console.log("会话文件      ", files.length, "（含用量的会话", sessions + "）");
console.log("成功请求      ", requests);
console.log("失败 / 取消   ", attempts.filter((row) => row.kind === "error").length, "/", attempts.filter((row) => row.kind === "aborted").length);
console.log("输入(未命中)  ", input.toLocaleString());
console.log("缓存读取      ", cacheRead.toLocaleString());
console.log("输出          ", output.toLocaleString());
console.log("总 tokens     ", total.toLocaleString());
console.log("缓存命中率    ", ((cacheRead / Math.max(1, cacheRead + input)) * 100).toFixed(2) + "%");
console.log("峰 / 谷 请求   ", peakRows, "/", requests - peakRows);
console.log("首字 ms       ", "P50", Math.round(percentile(ttfts, 0.5)), "P90", Math.round(percentile(ttfts, 0.9)));
console.log("速度 tok/s    ", "P50", percentile(speeds, 0.5).toFixed(1), "P90", percentile(speeds, 0.9).toFixed(1));
console.log("已定价 / 未定价", priced.length, "/", unpriced.length);
console.log("总成本 CNY    ", costCny.toFixed(4));

const byModel = new Map();
for (const row of rows) {
	const key = `${row.provider || "?"} :: ${row.model || "?"}`;
	const entry = byModel.get(key) ?? { requests: 0, total: 0, cost: 0, priced: 0 };
	entry.requests += 1;
	entry.total += row.total;
	if (row.cost !== null) {
		entry.cost += row.costCny ?? 0;
		entry.priced += 1;
	}
	byModel.set(key, entry);
}
console.log("\n按模型：");
for (const [key, entry] of [...byModel].sort((a, b) => b[1].total - a[1].total)) {
	console.log(
		"  " + key.padEnd(46),
		String(entry.requests).padStart(5),
		"请求",
		entry.total.toLocaleString().padStart(14),
		"tokens",
		entry.priced === 0 ? "未定价" : "¥" + entry.cost.toFixed(4)
	);
}

if (VERBOSE) {
	console.log("\n最近 20 条：");
	for (const row of rows.slice(-20)) {
		console.log(
			[
				new Date(row.ts).toISOString(),
				row.model,
				row.input,
				row.cacheRead,
				row.output,
				row.ttft === null ? "-" : row.ttft + "ms",
				row.speed === null ? "-" : row.speed.toFixed(1) + "t/s",
				row.peak ? "峰值" : "谷时",
				row.cost === null ? "-" : "¥" + row.cost.toFixed(6)
			].join("  ")
		);
	}
}
