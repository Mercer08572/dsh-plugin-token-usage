#!/usr/bin/env node
/**
 * 离线自检：不启动 DSH、不开浏览器。
 *
 * 只检查能静态确定的东西：语法、manifest、patch、客户端 bundle 的注册形态、
 * 价格文件能否通过严格校验、主题 token 是否都在已核验清单里、有没有引入外部 URL。
 *
 * 运行：node tools/check.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePricingFile } from "../lib/core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(condition, message) {
	if (condition) return;
	failures.push(message);
}

function read(relative) {
	try {
		return readFileSync(join(ROOT, relative), "utf8");
	} catch (error) {
		failures.push(`${relative}: 读不到（${error.code ?? error.message}）`);
		return null;
	}
}

function checkSyntax(relative) {
	const result = spawnSync(process.execPath, ["--check", join(ROOT, relative)], { encoding: "utf8" });
	check(result.status === 0, `${relative}: 语法检查失败\n${result.stderr ?? ""}`);
}

// ── 1. 语法 ────────────────────────────────────────────────────────────────
for (const file of ["lib/index.js", "lib/core.js", "lib/client.js", "lib/client.chart.js", "tools/replay.mjs", "tools/selftest.mjs", "tools/render-smoke.mjs", "tools/check.mjs"]) {
	checkSyntax(file);
}

// ── 2. manifest ────────────────────────────────────────────────────────────
const manifest = JSON.parse(read("package.json") ?? "{}");
check(manifest.name === "dsh-client-ui-token-usage", "package.json: name 必须是 dsh-client-ui-token-usage");
check(manifest.type === "module", "package.json: 必须是 ESM");
check(manifest.main === "lib/index.js", "package.json: main 必须是 lib/index.js");
check(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "package.json: 缺少 dsh.bundle.patch");
check(manifest.dsh?.client?.platform === "web", "package.json: dsh.client.platform 必须是 web");
check(Array.isArray(manifest.files) && manifest.files.includes("pricing.json"), "package.json: files 必须包含 pricing.json");
check(Array.isArray(manifest.files) && manifest.files.includes("calendar.seed.json"), "package.json: files 必须包含 calendar.seed.json");
check(Array.isArray(manifest.files) && manifest.files.includes("lib"), "package.json: files 必须包含 lib");

// ── 3. patch ───────────────────────────────────────────────────────────────
const patch = read("cordis.patch.yml") ?? "";
check(patch.includes("id: token-usage"), "cordis.patch.yml: 缺少 id: token-usage");
check(patch.includes("name: 'dsh-client-ui-token-usage'"), "cordis.patch.yml: 缺少 name");

// ── 4. locale ──────────────────────────────────────────────────────────────
for (const lang of ["zh", "en"]) {
	const raw = read(`locale/${lang}.json`);
	if (raw === null) continue;
	try {
		const parsed = JSON.parse(raw);
		check(typeof parsed?.meta?.title === "string" && parsed.meta.title !== "", `locale/${lang}.json: 缺少 meta.title`);
		check(typeof parsed?.meta?.description === "string", `locale/${lang}.json: 缺少 meta.description`);
	} catch (error) {
		failures.push(`locale/${lang}.json: 不是合法 JSON（${error.message}）`);
	}
}

// ── 5. 客户端 bundle 形态 ──────────────────────────────────────────────────
const client = read("lib/client.js") ?? "";
check(client.includes("window.__ModuleLoader__.load({"), "lib/client.js: 缺少 window.__ModuleLoader__.load({ 注册");
check(client.includes('id: "dsh-client-ui-token-usage"'), "lib/client.js: 注册 id 与包名不一致");
check(client.includes('require("react")'), "lib/client.js: 必须以 require('react') 取 React");
check(client.includes('require.async("./client.chart.js")'), "lib/client.js: 必须以 require.async 加载包内 chunk");
check(client.includes("export") === false || !/^\s*export\s/m.test(client), "lib/client.js: bundle 内不能出现 ESM export");
check(!/require\("(?!react)/.test(client), "lib/client.js: 只能 require('react')，第三方库必须走包内 chunk");
check(!/from\s+"[^"]+"/.test(client), "lib/client.js: bundle 内不能 import");
check(!/https?:\/\//.test(client.replace(/https?:\/\/(www\.)?(chart\.js|github\.com)[^\s"']*/g, "")), "lib/client.js: 不应包含外部 URL");

// 客户端只允许调用自己的相对路由
const fetches = [...client.matchAll(/fetch\(([^)]*)/g)].map((match) => match[1].trim());
check(fetches.length > 0, "lib/client.js: 找不到 fetch 调用");
for (const target of fetches) check(target.startsWith("API_PATH"), `lib/client.js: fetch 目标必须是 API_PATH，实际 ${target}`);

// ── 6. Chart.js chunk ──────────────────────────────────────────────────────
const chart = read("lib/client.chart.js") ?? "";
check(chart.includes('id: "dsh-client-ui-token-usage/client.chart.js"'), "lib/client.chart.js: chunk id 必须是 <包名>/client.chart.js");
check(chart.includes("Chart.js v4"), "lib/client.chart.js: 看起来不是 vendor 的 Chart.js");
check(chart.length > 100000, "lib/client.chart.js: 体积异常，可能不是完整 UMD");

// ── 7. 价格文件 ────────────────────────────────────────────────────────────
const pricingText = read("pricing.json");
if (pricingText !== null) {
	try {
		const parsed = parsePricingFile(pricingText);
		check(parsed.models.length > 0, "pricing.json: 至少要有 1 个模型");
		const ids = new Set();
		for (const model of parsed.models) {
			const key = model.provider + "\u0000" + model.model;
			check(!ids.has(key), `pricing.json: 重复的 ${model.provider}/${model.model}`);
			ids.add(key);
			check(["CNY", "USD"].includes(model.currency), `pricing.json: ${model.model} 币种非法`);
		}
		notes.push(`pricing.json: ${parsed.models.length} 个模型通过严格校验`);
	} catch (error) {
		failures.push("pricing.json: " + error.message);
	}
} else {
	failures.push("pricing.json: 文件不存在");
}

// ── 8. 节假日种子 ──────────────────────────────────────────────────────────
const seedText = read("calendar.seed.json");
if (seedText !== null) {
	try {
		const seed = JSON.parse(seedText);
		const years = Object.keys(seed.years ?? {});
		check(years.length > 0, "calendar.seed.json: 没有任何年份");
		for (const year of years) {
			for (const day of seed.years[year]) {
				check(/^\d{4}-\d{2}-\d{2}$/.test(day.date), `calendar.seed.json: ${year} 有非法日期 ${day.date}`);
				check(typeof day.off === "boolean", `calendar.seed.json: ${day.date} 缺少 off 布尔值`);
			}
		}
		notes.push(`calendar.seed.json: ${years.join(" / ")}`);
	} catch (error) {
		failures.push("calendar.seed.json: " + error.message);
	}
}

// ── 9. 主题 token 白名单 ───────────────────────────────────────────────────
const ALLOWED_TOKENS = new Set([
	"--dsw-alias-bg-overlay",
	"--dsw-alias-bg-layer-1",
	"--dsw-alias-border-l1",
	"--dsw-alias-border-l4",
	"--dsw-alias-label-primary",
	"--dsw-alias-label-secondary",
	"--dsw-alias-label-tertiary",
	"--dsw-alias-interactive-bg-hover",
	"--dsw-alias-interactive-bg-active",
	"--dsw-alias-state-business-primary",
	"--dsw-alias-state-success-primary",
	"--dsw-alias-state-error-primary",
	"--dsw-alias-state-warning-primary",
	"--dsw-radius-xs",
	"--dsw-radius-sm",
	"--dsw-radius-md",
	"--dsw-radius-lg",
	"--dsw-elevation-prominent",
	"--dsw-font-family",
	"--dsw-focus-ring-width",
	"--dsw-focus-ring-color",
	"--ds-font-family-code"
]);
for (const token of new Set([...client.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))) {
	check(ALLOWED_TOKENS.has(token), `lib/client.js: 未核验的主题 token ${token}`);
}

// ── 10. Host 侧不得引入三方依赖 ────────────────────────────────────────────
const host = read("lib/index.js") ?? "";
for (const match of host.matchAll(/from "([^"]+)"/g)) {
	const source = match[1];
	check(source.startsWith("node:") || source.startsWith("./"), `lib/index.js: 不允许的三方依赖 ${source}`);
}
check(host.includes('"/__token-usage"') || host.includes("ROUTE_PATH = \"/__token-usage\""), "lib/index.js: 路由路径不对");
check(host.includes("x-token-usage-client"), "lib/index.js: 缺少客户端标记校验");
check(!host.includes("import { DatabaseSync } from \"better-sqlite3\""), "lib/index.js: 不要引 better-sqlite3");

if (failures.length > 0) {
	console.error("自检失败（" + failures.length + "）：");
	for (const failure of failures) console.error("  - " + failure);
	process.exit(1);
}

console.log("自检通过。");
for (const note of notes) console.log("  · " + note);
console.log("  提示：界面观感与交互请在真实页面验证（侧边栏「用量」按钮 → 面板 → 各卡片有数 → 设置能改价）。");
