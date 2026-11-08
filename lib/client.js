/**
 * Token 用量看板 —— 浏览器半边。
 *
 * 两个挂载点：
 * 1. `sidebar.footer.action`（root）：侧边栏底部的「用量」按钮，任何页面都在；
 * 2. `shell.overlay`（root）：全屏面板本体。第三方插件没有独立路由页可注册，
 *    浮层是唯一稳的形态（与 todolist 同一套做法）。
 *
 * 数据全部来自 Host 的 `POST /__token-usage`：客户端只做展示与筛选，
 * 成本、峰谷、命中率都不在这里重算 —— 口径只有 Host 一份。
 */
window.__ModuleLoader__.load({
	id: "dsh-client-ui-token-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = react;
		/** 极简 JSX 替代：bundle 直接发布，不经过编译。 */
		const h = react.createElement;

		const API_PATH = "/__token-usage";
		const NS = "token-usage";

		//#region 语言

		/** 由 apply() 绑定到 ctx.locale；未绑定时退化为原样返回键名。 */
		let t = (key) => key;
		function translateOf(props) {
			return typeof props.t === "function" ? props.t : t;
		}

		const zh = {
			"button.open": "Token 用量",
			"panel.title": "Token 用量",
			"panel.subtitle": "数据来自本机会话日志；成本按写入时价格冻结，仅供参考",
			"panel.close": "关闭",
			"panel.settings": "价格与汇率设置",
			"card.requests": "总请求数",
			"card.failures": "失败 {error} 次 · 取消 {aborted} 次",
			"card.failuresHint": "只统计成功调用；失败与取消不会进入请求数、token 与成本。",
			"card.tokens": "Token 消耗",
			"card.today": "今日",
			"card.hit": "缓存命中率",
			"card.hitHint": "缓存读取 ÷（缓存读取 + 未命中输入）",
			"card.cost": "总成本",
			"card.costNote": "仅供参考",
			"card.costHint": "成本在每次请求结束时按当时价格算好并冻结；改价只影响之后的请求。",
			"card.unpriced": "{n} 个模型未定价",
			"card.requestsToday": "{n} 次请求",
			"error.window": "时间窗格式应为 09:00-12:00，多个用逗号分隔",
			"error.pickDate": "先选日期",
			"settings.calendarYearItem": "{year}（{days} 天）",
			"trend.title": "每日趋势",
			"trend.range7": "7 天",
			"trend.range30": "30 天",
			"trend.range90": "90 天",
			"trend.input": "未命中输入",
			"trend.cache": "缓存读取",
			"trend.output": "输出",
			"trend.requests": "请求数",
			"heat.title": "每日 Token 热力图",
			"range.label": "统计范围",
			"range.days": "{n} 天",
			"range.all": "全部",
			"heat.less": "少",
			"heat.tip": "{date} · {tokens} tokens · {requests} 次请求",
			"heat.more": "多",
			"logs.title": "请求日志",
			"logs.time": "时间",
			"logs.model": "模型",
			"logs.input": "输入",
			"logs.output": "输出",
			"logs.cache": "缓存命中",
			"logs.rate": "命中率",
			"logs.speed": "速度",
			"logs.ttft": "首字",
			"logs.cost": "成本",
			"logs.costHint": "按写入时价格计算，仅供参考；未定价显示 —",
			"logs.allModels": "全部模型",
			"logs.empty": "还没有记录。发起一次对话后这里会出现数据。",
			"logs.prev": "上一页",
			"logs.next": "下一页",
			"logs.page": "第 {page} / {pages} 页 · 共 {total} 条",
			"settings.title": "价格与汇率",
			"settings.close": "关闭设置",
			"settings.currency": "显示币种",
			"settings.fx": "汇率",
			"settings.fxHint": "每天自动获取一次中间价，只影响之后写入的记录；无需手动设置，失败时保留上一次的值。",
			"settings.fxRefresh": "刷新汇率",
			"settings.fxSource": "来源",
			"settings.pricing": "模型价格",
			"settings.pricingHint": "单价按「每百万 tokens」填写。改价只影响之后的请求，历史成本保持不变。",
			"settings.priced": "已定价",
			"settings.unpriced": "未定价",
			"settings.edit": "编辑",
			"settings.add": "设置价格",
			"settings.save": "保存",
			"settings.cancel": "取消",
			"settings.remove": "删除价格",
			"settings.currencyField": "币种",
			"settings.input": "输入（未命中）",
			"settings.cacheRead": "缓存读取",
			"settings.cacheWrite": "缓存写入",
			"settings.output": "输出",
			"settings.peakValley": "峰谷计费",
			"settings.tier": "长上下文分档",
			"settings.tierFrom": "触发阈值（prompt tokens）",
			"settings.tierInput": "分档输入",
			"settings.tierCacheRead": "分档缓存读",
			"settings.tierCacheWrite": "分档缓存写",
			"settings.tierOutput": "分档输出",
			"settings.tierHint": "prompt = 未命中输入 + 缓存读 + 缓存写；超过阈值后，本次请求的全部 token 都按分档单价计价（整单生效，不是只对超出部分加价）。",
			"settings.tierBadge": "分档 >{from}",
			"error.tierFrom": "分档阈值必须是正数",
			"settings.windows": "时间窗",
			"settings.windowsHint": "形如 09:00-12:00,14:00-18:00",
			"settings.windowsMean": "窗口内是",
			"settings.meanPeak": "峰时",
			"settings.meanValley": "谷时",
			"settings.discount": "谷时折扣",
			"settings.weekend": "周末",
			"settings.holiday": "法定节假日",
			"settings.followWindows": "按时钟",
			"settings.peak": "峰时",
			"settings.valley": "谷时",
			"settings.calendar": "节假日日历",
			"settings.calendarHint": "只有「法定节假日全天谷价」才需要它。调休补班日仍算周末（除非把「周末」设为按时钟）。",
			"settings.calendarYears": "已载入年份",
			"settings.calendarRefresh": "更新 {year} 年",
			"settings.calendarAdd": "手动补录",
			"settings.calendarDate": "日期",
			"settings.calendarKind": "类型",
			"settings.calendarAsHoliday": "法定节假日",
			"settings.calendarAsWorkday": "补班日",
			"settings.calendarAddBtn": "添加",
			"settings.calendarNote": "数据来自国务院公告（holiday-cn），更新失败不影响已有数据。",
			"settings.unpricedModels": "未定价模型",
			"settings.unpricedHint": "同一模型在不同 provider 下的写法已自动合并（忽略大小写与 vendor 前缀）。",
			"settings.variants": "{n} 个 provider · {requests} 请求",
			"settings.aliases": "模型别名",
			"settings.aliasesHint": "只有程序判断不了的才需要它：把某个写法映射到已定价的规范名，例如 deepseek-v4-flash → deepseek-flash。",
			"settings.aliasFrom": "别名（会被归一化）",
			"settings.aliasTo": "规范名",
			"settings.aliasAdd": "添加别名",
			"settings.aliasEmpty": "还没有别名。",
			"settings.modelSettings": "模型",
			"settings.modelSettingsHint": "价格与别名都在弹窗里编辑，列表再长也不会把设置页拉长。",
			"settings.openPricing": "模型价格",
			"settings.openAliases": "模型别名",
			"settings.openCalendar": "节假日日历",
			"settings.allProviders": "全部 provider",
			"error.load": "加载失败：",
			"error.pricing": "pricing.json 解析失败，仍在使用上一次的价格：",
			"error.save": "保存失败：",
			"loading": "加载中…",
			"backfill.running": "正在回填历史会话，数字会在几秒内补齐…"
		};

		const en = {
			"button.open": "Token usage",
			"panel.title": "Token usage",
			"panel.subtitle": "From this machine's session logs. Cost is frozen at write time and is indicative only.",
			"panel.close": "Close",
			"panel.settings": "Pricing and exchange rate",
			"card.requests": "Requests",
			"card.failures": "failed {error} · cancelled {aborted}",
			"card.failuresHint": "Only successful calls count toward requests, tokens and cost.",
			"card.tokens": "Tokens",
			"card.today": "Today",
			"card.hit": "Cache hit rate",
			"card.hitHint": "cache read ÷ (cache read + uncached input)",
			"card.cost": "Total cost",
			"card.costNote": "for reference",
			"card.costHint": "Cost is computed and frozen when each request settles; price edits affect later requests only.",
			"card.unpriced": "{n} models unpriced",
			"card.requestsToday": "{n} requests",
			"error.window": "Windows look like 09:00-12:00; separate multiple with commas",
			"error.pickDate": "Pick a date first",
			"settings.calendarYearItem": "{year} ({days} days)",
			"trend.title": "Daily trend",
			"trend.range7": "7d",
			"trend.range30": "30d",
			"trend.range90": "90d",
			"trend.input": "Uncached input",
			"trend.cache": "Cache read",
			"trend.output": "Output",
			"trend.requests": "Requests",
			"heat.title": "Daily token heatmap",
			"range.label": "Scope",
			"range.days": "{n} days",
			"range.all": "All",
			"heat.less": "Less",
			"heat.tip": "{date} · {tokens} tokens · {requests} requests",
			"heat.more": "More",
			"logs.title": "Request log",
			"logs.time": "Time",
			"logs.model": "Model",
			"logs.input": "In",
			"logs.output": "Out",
			"logs.cache": "Cache",
			"logs.rate": "Hit",
			"logs.speed": "Speed",
			"logs.ttft": "TTFT",
			"logs.cost": "Cost",
			"logs.costHint": "Computed at write time, for reference; — means unpriced.",
			"logs.allModels": "All models",
			"logs.empty": "No records yet. Start a conversation and they will show up here.",
			"logs.prev": "Prev",
			"logs.next": "Next",
			"logs.page": "Page {page} / {pages} · {total} rows",
			"settings.title": "Pricing and FX",
			"settings.close": "Close settings",
			"settings.currency": "Display currency",
			"settings.fx": "Exchange rate",
			"settings.fxHint": "Fetched once a day and applied to future rows only. Nothing to configure; a failed fetch keeps the previous value.",
			"settings.fxRefresh": "Refresh",
			"settings.fxSource": "source",
			"settings.pricing": "Model pricing",
			"settings.pricingHint": "Prices are per million tokens. Edits affect future requests only; history stays frozen.",
			"settings.priced": "priced",
			"settings.unpriced": "unpriced",
			"settings.edit": "Edit",
			"settings.add": "Set price",
			"settings.save": "Save",
			"settings.cancel": "Cancel",
			"settings.remove": "Remove",
			"settings.currencyField": "Currency",
			"settings.input": "Input (miss)",
			"settings.cacheRead": "Cache read",
			"settings.cacheWrite": "Cache write",
			"settings.output": "Output",
			"settings.peakValley": "Peak / off-peak",
			"settings.tier": "Long-context tier",
			"settings.tierFrom": "Threshold (prompt tokens)",
			"settings.tierInput": "Tier input",
			"settings.tierCacheRead": "Tier cache read",
			"settings.tierCacheWrite": "Tier cache write",
			"settings.tierOutput": "Tier output",
			"settings.tierHint": "prompt = uncached input + cache read + cache write; above the threshold the whole request is repriced at these rates (whole-request, not just the excess).",
			"settings.tierBadge": "tier >{from}",
			"error.tierFrom": "Tier threshold must be positive",
			"settings.windows": "Windows",
			"settings.windowsHint": "e.g. 09:00-12:00,14:00-18:00",
			"settings.windowsMean": "Windows are",
			"settings.meanPeak": "peak",
			"settings.meanValley": "off-peak",
			"settings.discount": "Off-peak factor",
			"settings.weekend": "Weekend",
			"settings.holiday": "Public holiday",
			"settings.followWindows": "by clock",
			"settings.peak": "peak",
			"settings.valley": "off-peak",
			"settings.calendar": "Holiday calendar",
			"settings.calendarHint": "Only needed for all-day off-peak on statutory holidays. Makeup workdays still count as weekends unless Weekend is set to by-clock.",
			"settings.calendarYears": "Loaded years",
			"settings.calendarRefresh": "Update {year}",
			"settings.calendarAdd": "Manual override",
			"settings.calendarDate": "Date",
			"settings.calendarKind": "Kind",
			"settings.calendarAsHoliday": "Holiday",
			"settings.calendarAsWorkday": "Workday",
			"settings.calendarAddBtn": "Add",
			"settings.calendarNote": "Sourced from State Council announcements (holiday-cn). A failed update keeps existing data.",
			"settings.unpricedModels": "Unpriced models",
			"settings.unpricedHint": "Provider variants of the same model are merged (case and vendor prefix ignored).",
			"settings.variants": "{n} providers · {requests} requests",
			"settings.aliases": "Model aliases",
			"settings.aliasesHint": "Only for cases software cannot judge: map another spelling onto a priced canonical name, e.g. deepseek-v4-flash → deepseek-flash.",
			"settings.aliasFrom": "Alias (normalized)",
			"settings.aliasTo": "Canonical",
			"settings.aliasAdd": "Add alias",
			"settings.aliasEmpty": "No aliases yet.",
			"settings.modelSettings": "Models",
			"settings.modelSettingsHint": "Pricing and aliases open in dialogs, so long lists no longer stretch this page.",
			"settings.openPricing": "Model pricing",
			"settings.openAliases": "Model aliases",
			"settings.openCalendar": "Holiday calendar",
			"settings.allProviders": "all providers",
			"error.load": "Load failed: ",
			"error.pricing": "pricing.json could not be parsed; the previous prices are still in use: ",
			"error.save": "Save failed: ",
			"loading": "Loading…",
			"backfill.running": "Backfilling past sessions; numbers will fill in within a few seconds…"
		};

		//#endregion

		//#region 样式

		const css = `
/* 侧边栏底部入口：尺寸与 dsh-plugin-todolist 的 .dst-sidebarButton 逐项对齐，
   否则并排时 hover 高亮的高度会差 4px，看起来像没对齐。 */
.tu-entry{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:18px}
.tu-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-entry[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-entry:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tu-entryIcon{justify-content:center;padding:0;width:28px}
.tu-btn{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px}
.tu-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tu-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit}
.tu-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-icon:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tu-backdrop{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto}
.tu-panel{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:min(1100px,100%);height:min(840px,calc(100vh - 48px));border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;overflow:hidden}
.tu-head{flex:none;display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tu-headMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tu-title{font-size:14px;font-weight:600;line-height:20px}
.tu-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tu-seg{display:inline-flex;align-items:center;box-sizing:border-box;padding:2px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.tu-segItem{height:24px;padding:0 10px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px}
.tu-segItem:hover{color:var(--dsw-alias-label-primary)}
.tu-segItem[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}
.tu-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:14px}
.tu-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
@media (max-width:900px){.tu-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tu-card{position:relative;display:flex;flex-direction:column;gap:4px;padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.tu-cardLabel{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.tu-cardValue{font-family:var(--ds-font-family-code);font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tu-cardSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tu-warn{color:var(--dsw-alias-state-warning-primary,#d29922)}
.tu-tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:1;cursor:help}
.tu-tipBody{position:fixed;z-index:9999;display:block;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:normal;text-align:left;pointer-events:none;overflow-wrap:anywhere}
.tu-scope{display:flex;align-items:center;gap:8px;margin-top:-4px}
.tu-scopeLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tu-section{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:12px}
.tu-sectionHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.tu-sectionTitle{flex:1;font-size:13px;font-weight:600}
.tu-chartBox{position:relative;height:220px}
.tu-heat{overflow-x:auto;padding-bottom:4px}
.tu-heatInner{margin:0 auto;width:max-content;display:flex;flex-direction:column;gap:2px}
.tu-heatMonths{display:grid;grid-template-rows:12px;grid-auto-flow:column;grid-auto-columns:11px;gap:3px;margin-bottom:2px}
.tu-heatMonth{color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:12px;white-space:nowrap;overflow:visible}
.tu-heatGrid{display:grid;grid-template-rows:repeat(7,11px);grid-auto-flow:column;grid-auto-columns:11px;gap:3px}
.tu-cell{width:11px;height:11px;border-radius:2px;background:rgba(127,127,127,.18)}
.tu-cell[data-level="1"]{background:#9be9a8}
.tu-cell[data-level="2"]{background:#40c463}
.tu-cell[data-level="3"]{background:#30a14e}
.tu-cell[data-level="4"]{background:#216e39}
.tu-legend{display:flex;align-items:center;gap:3px;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px}
.tu-tableWrap{overflow-x:auto}
.tu-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}
.tu-table th{position:sticky;top:0;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:right;background:var(--dsw-alias-bg-layer-1)}
.tu-table th:first-child,.tu-table th:nth-child(2){text-align:left}
.tu-table td{padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);text-align:right;font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.tu-table td:first-child,.tu-table td:nth-child(2){text-align:left;font-family:var(--dsw-font-family)}
.tu-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.tu-model{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tu-muted{color:var(--dsw-alias-label-tertiary)}
.tu-pager{display:flex;align-items:center;gap:8px;margin-top:10px}
.tu-pagerInfo{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px}
.tu-select,.tu-input{box-sizing:border-box;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.tu-input{width:100%}
.tu-input:focus-visible,.tu-select:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.tu-errorColor{color:var(--dsw-alias-state-error-primary)}
.tu-dialogMask{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto}
.tu-dialog{display:flex;flex-direction:column;box-sizing:border-box;width:min(640px,100%);max-height:min(700px,calc(100vh - 48px));border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);pointer-events:auto}
.tu-dialogHead{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tu-dialogTitle{flex:1;font-size:13px;font-weight:600}
.tu-dialogBody{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 18px;display:flex;flex-direction:column;gap:10px}
.tu-sheetMask{position:absolute;inset:0;z-index:6;background:rgba(0,0,0,.35)}
.tu-sheet{position:absolute;top:0;right:0;bottom:0;z-index:7;display:flex;flex-direction:column;box-sizing:border-box;width:min(460px,100%);border-left:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent)}
.tu-sheetHead{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tu-sheetTitle{flex:1;font-size:13px;font-weight:600}
.tu-sheetBody{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 20px;display:flex;flex-direction:column;gap:16px}
.tu-block{display:flex;flex-direction:column;gap:8px}
.tu-blockHead{font-size:12px;font-weight:600}
.tu-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tu-field{display:flex;flex-direction:column;gap:4px}
.tu-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}
.tu-row{display:flex;align-items:center;gap:8px}
.tu-rowWrap{display:flex;flex-wrap:wrap;gap:8px}
.tu-grow{flex:1;min-width:0}
.tu-priceRow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tu-priceName{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tu-priceModel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.tu-priceMeta{color:var(--dsw-alias-label-tertiary);font-size:10px}
.tu-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font-size:10px;line-height:18px}
.tu-badge[data-kind="ok"]{background:rgba(63,185,80,.16);color:#3fb950}
.tu-badge[data-kind="warn"]{background:rgba(210,153,34,.16);color:#d29922}
.tu-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);margin:8px 0}
.tu-form .tu-full{grid-column:1 / -1}
.tu-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
`;

		/** 注入样式表；随插件卸载移除（与 todolist 同一套生命周期约定）。 */
		function insertStyles() {
			const style = document.createElement("style");
			style.dataset.plugin = "token-usage";
			style.textContent = css;
			document.head.appendChild(style);
			return () => style.remove();
		}

		//#endregion

		//#region 面板状态与数据访问

		/**
		 * 语言：只读 DSH 设置里的语言，用来决定界面语言之外的**币种**。
		 * 中文 → ¥，其他 → $（没有单独开关，少一个需要维护的偏好）。
		 */
		const languageStore = (() => {
			const listeners = new Set();
			let snapshot = { active: "en" };
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: () => snapshot,
				sync(active) {
					const next = typeof active === "string" && active !== "" ? active : "en";
					if (next === snapshot.active) return;
					snapshot = { active: next };
					for (const listener of [...listeners]) listener();
				}
			};
		})();

		/** 顶部卡片的统计范围：7 天 / 30 天 / 全部（0）。 */
		const RANGES = [7, 30, 0];
		function rangeLabel(tr, value) {
			return value === 0 ? tr("range.all") : tr("range.days").replace("{n}", String(value));
		}

		/** 语言 → 计价币种：中文用人民币，其余用美元。 */
		function currencyOf(language) {
			return String(language ?? "").toLowerCase().startsWith("zh") ? "CNY" : "USD";
		}

		/** 面板开合：侧边栏按钮与浮层各挂一处，靠这个模块级 store 同步。 */
		const panelState = (() => {
			const listeners = new Set();
			let open = false;
			let snapshot = { open };
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: () => snapshot,
				toggle() {
					open = !open;
					snapshot = { open };
					for (const listener of [...listeners]) listener();
				},
				close() {
					if (!open) return;
					open = false;
					snapshot = { open };
					for (const listener of [...listeners]) listener();
				}
			};
		})();

		/** 调用 Host 接口；失败抛带原因的错误。 */
		async function callApi(action, payload) {
			const response = await fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json", "x-token-usage-client": "1" },
				body: JSON.stringify({ action, ...(payload ?? {}) })
			});
			let data = null;
			try {
				data = await response.json();
			} catch {
				data = null;
			}
			if (!response.ok || data === null || data.ok !== true) {
				throw new Error(data !== null && typeof data.error === "string" ? data.error : "HTTP " + response.status);
			}
			return data;
		}

		//#endregion

		//#region 格式化

		const TZ = "Asia/Shanghai";
		const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
			timeZone: TZ,
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false
		});

		/** 大数字缩写：12.3K / 4.56M / 1.02B。 */
		function fmtTokens(value) {
			const number = Number(value) || 0;
			if (number >= 1e9) return (number / 1e9).toFixed(2) + "B";
			if (number >= 1e6) return (number / 1e6).toFixed(2) + "M";
			if (number >= 1e4) return (number / 1e3).toFixed(1) + "K";
			return String(Math.round(number));
		}

		/** 金额：小额多给两位小数，避免全是 0.00。 */
		function fmtMoney(value, currency) {
			if (value === null || value === undefined) return "—";
			const symbol = currency === "USD" ? "$" : "¥";
			const number = Number(value) || 0;
			const abs = Math.abs(number);
			const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
			return symbol + number.toFixed(digits);
		}

		function fmtPercent(value) {
			if (value === null || value === undefined) return "—";
			return (Number(value) * 100).toFixed(2) + "%";
		}

		function fmtTime(ts) {
			return TIME_FMT.format(new Date(ts));
		}

		/** 本地日期键（与 Host 的 dayKey 对齐，用同一个时区）。 */
		const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
		function dayKeyOf(date) {
			return DAY_FMT.format(date);
		}

		//#endregion

		//#region 图标

		function GaugeIcon() {
			return h(
				"svg",
				{ viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" },
				h("path", { d: "M2.5 12.5a6 6 0 1 1 11 0" }),
				h("path", { d: "M8 12.5 11 7" })
			);
		}

		function CloseIcon() {
			return h(
				"svg",
				{ viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
				h("path", { d: "M4 4l8 8M12 4l-8 8" })
			);
		}

		//#endregion

		//#region Chart.js chunk

		let chartPromise = null;
		/** 按需加载 Chart.js：失败只影响趋势图，其余界面照常。 */
		function loadChart() {
			if (chartPromise === null) {
				chartPromise = require.async("./client.chart.js").then((loaded) => loaded.Chart ?? loaded);
			}
			return chartPromise;
		}

		/** canvas 不能直接吃主题变量，必须读出解析后的颜色。 */
		function themeColor(name, fallback) {
			try {
				const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
				return value === "" ? fallback : value;
			} catch {
				return fallback;
			}
		}

		//#endregion

		//#region 子组件

		/** 带悬浮说明的小圆点。 */
		/**
		 * 悬浮说明。tooltip 用 position:fixed 挂在视口坐标上：
		 * 面板正文是滚动容器，absolute 的浮层会被裁掉（顶部卡片尤其明显），
		 * 这里在 mouseenter 时算一次位置，并用视口边界夹取，保证不被截断。
		 */
		function Hint(props) {
			const anchorRef = useRef(null);
			const [pos, setPos] = useState(null);
			const show = () => {
				const node = anchorRef.current;
				if (node === null || typeof window === "undefined") return;
				const rect = node.getBoundingClientRect();
				const width = Math.min(260, Math.max(160, window.innerWidth - 32));
				const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
				// 空间不够就翻到上方；用 bottom 锚定，这样不依赖 tooltip 自身高度，长文本也不会顶出屏幕。
				const above = rect.bottom + 140 > window.innerHeight;
				setPos({ left, width, above, top: rect.bottom + 6, bottom: window.innerHeight - rect.top + 6 });
			};
			return h(
				"span",
				{
					ref: anchorRef,
					className: "tu-tip",
					"aria-label": props.text,
					role: "note",
					onMouseEnter: show,
					onMouseLeave: () => setPos(null),
					onFocus: show,
					onBlur: () => setPos(null),
					tabIndex: 0
				},
				props.label ?? "?",
				pos === null
					? null
					: h(
							"span",
							{
								className: "tu-tipBody",
								style: pos.above
									? { left: pos.left + "px", bottom: pos.bottom + "px", width: pos.width + "px" }
									: { left: pos.left + "px", top: pos.top + "px", width: pos.width + "px" }
							},
							props.text
						)
			);
		}

		function Card(props) {
			return h(
				"div",
				{ className: "tu-card" },
				h("div", { className: "tu-cardLabel" }, props.label, props.hint === undefined ? null : h(Hint, { text: props.hint })),
				h("div", { className: "tu-cardValue" }, props.value),
				h("div", { className: "tu-cardSub" }, props.sub)
			);
		}

		/** 顶部四张卡。 */
		function StatCards(props) {
			const tr = props.tr;
			const overview = props.overview;
			if (overview === null) return null;
			const totals = overview.totals;
			const failures = overview.failures;
			const unpricedText = tr("card.unpriced").replace("{n}", String(overview.unpriced.length));
			return h(
				"div",
				{ className: "tu-cards" },
				h(Card, {
					label: tr("card.cost") + " · " + tr("card.costNote"),
					hint: tr("card.costHint") + (overview.unpriced.length > 0 ? " " + unpricedText : ""),
					value: fmtMoney(totals.cost, overview.currency),
					sub:
						overview.unpriced.length > 0
							? h("span", { className: "tu-warn" }, unpricedText)
							: tr("card.today") + " " + fmtMoney(overview.today.cost, overview.currency)
				}),
				h(Card, {
					label: tr("card.requests"),
					hint: tr("card.failuresHint"),
					value: String(totals.requests),
					sub: h(Hint, {
						label: "!",
						text: tr("card.failures").replace("{error}", String(failures.error)).replace("{aborted}", String(failures.aborted))
					})
				}),
				h(Card, {
					label: tr("card.tokens"),
					value: fmtTokens(totals.total),
					sub: tr("card.today") + " +" + fmtTokens(overview.today.tokens)
				}),
				h(Card, {
					label: tr("card.hit"),
					hint: tr("card.hitHint"),
					value: fmtPercent(overview.hitRate),
					sub: tr("card.today") + " +" + tr("card.requestsToday").replace("{n}", String(overview.today.requests))
				})
			);
		}

		/** 趋势：堆叠柱（未命中输入 / 缓存读取 / 输出）+ 请求数折线。 */
		function TrendSection(props) {
			const tr = props.tr;
			const range = props.range;
			const data = props.data;
			const canvasRef = useRef(null);
			const [error, setError] = useState(null);

			useEffect(() => {
				let alive = true;
				let chart = null;
				if (data === null || canvasRef.current === null) return undefined;
				loadChart()
					.then((Ctor) => {
						if (!alive || canvasRef.current === null) return;
						const text = themeColor("--dsw-alias-label-secondary", "#8b949e");
						const grid = themeColor("--dsw-alias-border-l1", "rgba(127,127,127,.25)");
						const input = themeColor("--dsw-alias-state-business-primary", "#4f8cff");
						const cache = themeColor("--dsw-alias-state-success-primary", "#3fb950");
						const output = themeColor("--dsw-alias-state-warning-primary", "#d29922");
						const requests = themeColor("--dsw-alias-label-tertiary", "#8b949e");
						const small = { size: 9 };
						chart = new Ctor(canvasRef.current, {
							type: "bar",
							data: {
								labels: data.map((day) => day.day.slice(5)),
								datasets: [
									{ label: tr("trend.input"), data: data.map((day) => day.input), backgroundColor: input, stack: "tokens", borderRadius: 2 },
									{ label: tr("trend.cache"), data: data.map((day) => day.cacheRead), backgroundColor: cache, stack: "tokens", borderRadius: 2 },
									{ label: tr("trend.output"), data: data.map((day) => day.output), backgroundColor: output, stack: "tokens", borderRadius: 2 },
									{
										type: "line",
										label: tr("trend.requests"),
										data: data.map((day) => day.requests),
										borderColor: requests,
										backgroundColor: requests,
										borderWidth: 1.5,
										pointRadius: 0,
										tension: 0.3,
										yAxisID: "y1"
									}
								]
							},
							options: {
								responsive: true,
								maintainAspectRatio: false,
								animation: false,
								interaction: { mode: "index", intersect: false },
								plugins: {
									legend: { labels: { color: text, boxWidth: 8, font: small } },
									tooltip: {
										callbacks: {
											label: (context) => {
												const isTokens = context.dataset.yAxisID !== "y1";
												return context.dataset.label + ": " + (isTokens ? fmtTokens(context.parsed.y) : String(context.parsed.y));
											}
										}
									}
								},
								scales: {
									x: { stacked: true, ticks: { color: text, font: small, maxRotation: 0, autoSkip: true }, grid: { display: false } },
									y: {
										stacked: true,
										beginAtZero: true,
										ticks: { color: text, font: small, callback: (value) => fmtTokens(value) },
										grid: { color: grid }
									},
									y1: {
										position: "right",
										beginAtZero: true,
										ticks: { color: text, font: small, precision: 0 },
										grid: { drawOnChartArea: false }
									}
								}
							}
						});
						setError(null);
					})
					.catch((reason) => {
						if (alive) setError(reason instanceof Error ? reason.message : String(reason));
					});
				return () => {
					alive = false;
					if (chart !== null) chart.destroy();
				};
			}, [data]);

			return h(
				"div",
				{ className: "tu-section" },
				h(
					"div",
					{ className: "tu-sectionHead" },
					h("div", { className: "tu-sectionTitle" }, tr("trend.title")),
					h(
						"div",
						{ className: "tu-seg", role: "group", "aria-label": tr("trend.title") },
						[7, 30, 90].map((days) =>
							h(
								"button",
								{
									key: days,
									type: "button",
									className: "tu-segItem",
									"data-active": props.range === days ? "true" : "false",
									onClick: () => props.onRange(days)
								},
								tr("trend.range" + days)
							)
						)
					)
				),
				error === null ? null : h("div", { className: "tu-hint tu-errorColor" }, error),
				h("div", { className: "tu-chartBox" }, h("canvas", { ref: canvasRef }))
			);
		}

		/** 热力图：53 周 × 7 天，按当天 total tokens 分 5 档。 */
		function HeatmapSection(props) {
			const tr = props.tr;
			const days = props.data;
			const [tip, setTip] = useState(null);
			const monthFmt = useMemo(() => {
				const tag = String(props.language ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
				return new Intl.DateTimeFormat(tag, { month: "short" });
			}, [props.language]);

			/** 原生 title 在部分 WebView 里不弹，这里自己做视口定位的浮层。 */
			const showTip = (event, cell) => {
				const node = event.currentTarget;
				const rect = node.getBoundingClientRect();
				const width = 200;
				const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
				const above = rect.top < 64;
				const entry = cell.entry;
				const text =
					tr("heat.tip")
						.replace("{date}", cell.key)
						.replace("{tokens}", fmtTokens(entry === undefined ? 0 : entry.total))
						.replace("{requests}", String(entry === undefined ? 0 : entry.requests)) +
					(entry !== undefined && entry.cost > 0 ? " · " + fmtMoney(entry.cost, props.currency) : "");
				setTip({ left, width, above, top: rect.bottom + 6, bottom: window.innerHeight - rect.top + 6, text });
			};
			const cells = useMemo(() => {
				const map = new Map((days ?? []).map((day) => [day.day, day]));
				// 以 Host 的「上海日」为基准做整数递推，避免浏览器时区不同把格子挪一天。
				const todayKey = DAY_FMT.format(new Date());
				const [year, month, dayOfMonth] = todayKey.split("-").map(Number);
				const end = Date.UTC(year, month - 1, dayOfMonth);
				// 回退到 52 周前的周日：GitHub 的列是「自然周」，不按今天往前推 364 天，
				// 否则第一列会从今天的星期几开始，整张图会整体错位。
				const anchor = end - 52 * 7 * 86400000;
				const start = anchor - new Date(anchor).getUTCDay() * 86400000;
				const list = [];
				let max = 0;
				for (let ts = start; ts <= end; ts += 86400000) {
					const date = new Date(ts);
					const key = date.toISOString().slice(0, 10);
					const entry = map.get(key);
					if (entry !== undefined) max = Math.max(max, entry.total);
					list.push({ key, date, entry, column: Math.floor((ts - start) / 86400000 / 7) });
				}
				return { list, max: Math.max(1, max) };
			}, [days]);

			const level = (value) => {
				if (value === undefined || value <= 0) return 0;
				const ratio = value / cells.max;
				if (ratio > 0.66) return 4;
				if (ratio > 0.33) return 3;
				if (ratio > 0.12) return 2;
				return 1;
			};

			// 月份标签：每列第一天的月份与上一列不同时打一个。
			const months = [];
			let lastMonth = -1;
			for (let column = 0; column < 53; column += 1) {
				const first = cells.list.find((cell) => cell.column === column);
				if (first === undefined) continue;
				const month = first.date.getUTCMonth();
				const dateOfMonth = first.date.getUTCDate();
				months.push(month !== lastMonth && dateOfMonth <= 7 ? monthFmt.format(new Date(Date.UTC(2020, month, 1))) : "");
				lastMonth = month;
			}

			return h(
				"div",
				{ className: "tu-section" },
				h(
					"div",
					{ className: "tu-sectionHead" },
					h("div", { className: "tu-sectionTitle" }, tr("heat.title")),
					h(
						"div",
						{ className: "tu-legend" },
						tr("heat.less"),
						[0, 1, 2, 3, 4].map((value) => h("span", { key: value, className: "tu-cell", "data-level": String(value) })),
						tr("heat.more")
					)
				),
				h(
					"div",
					{ className: "tu-heat" },
					h(
						"div",
						{ className: "tu-heatInner" },
						h("div", { className: "tu-heatMonths" }, months.map((label, index) => h("div", { key: index, className: "tu-heatMonth" }, label))),
						h(
							"div",
							{ className: "tu-heatGrid" },
							cells.list.map((cell) =>
								h("div", {
									key: cell.key,
									className: "tu-cell",
									"data-level": String(level(cell.entry?.total)),
									"aria-label": cell.key,
									onMouseEnter: (event) => showTip(event, cell),
									onMouseLeave: () => setTip(null)
								})
							)
						)
					)
				),
				tip === null
					? null
					: h(
							"div",
							{
								className: "tu-tipBody",
								style: tip.above
									? { left: tip.left + "px", bottom: tip.bottom + "px", width: tip.width + "px" }
									: { left: tip.left + "px", top: tip.top + "px", width: tip.width + "px" }
							},
							tip.text
						)
			);
		}

		/** 请求日志表。 */
		function LogsSection(props) {
			const tr = props.tr;
			const logs = props.data;
			const models = props.models;
			const currency = props.currency;
			if (logs === null) return null;
			const pages = Math.max(1, Math.ceil(logs.total / logs.pageSize));
			return h(
				"div",
				{ className: "tu-section" },
				h(
					"div",
					{ className: "tu-sectionHead" },
					h("div", { className: "tu-sectionTitle" }, tr("logs.title")),
					h(
						"select",
						{
							className: "tu-select",
							value: props.filter,
							onChange: (event) => props.onFilter(event.target.value),
							"aria-label": tr("logs.model")
						},
						[h("option", { key: "", value: "" }, tr("logs.allModels"))].concat(
							models.map((entry) => h("option", { key: entry.provider + "\u0000" + entry.model, value: entry.provider + "\u0000" + entry.model }, entry.model))
						)
					)
				),
				logs.rows.length === 0
					? h("div", { className: "tu-hint" }, tr("logs.empty"))
					: h(
							"div",
							{ className: "tu-tableWrap" },
							h(
								"table",
								{ className: "tu-table" },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										h("th", null, tr("logs.time")),
										h("th", null, tr("logs.model")),
										h("th", null, tr("logs.input")),
										h("th", null, tr("logs.output")),
										h("th", null, tr("logs.cache")),
										h("th", null, tr("logs.rate")),
										h("th", null, tr("logs.speed")),
										h("th", null, tr("logs.ttft")),
										h(
											"th",
											{ title: tr("logs.costHint") },
											tr("logs.cost") + " *"
										)
									)
								),
								h(
									"tbody",
									null,
									logs.rows.map((row, index) =>
										h(
											"tr",
											{ key: row.ts + ":" + row.model + ":" + row.input },
											h("td", null, fmtTime(row.ts)),
											h("td", { className: "tu-model", title: row.provider + " / " + row.model }, row.model),
											h("td", null, fmtTokens(row.input)),
											h("td", null, fmtTokens(row.output)),
											h("td", null, fmtTokens(row.cacheRead)),
											h("td", null, row.input + row.cacheRead === 0 ? "—" : fmtPercent(row.cacheRead / (row.input + row.cacheRead))),
											h("td", null, row.speed === null ? "—" : row.speed.toFixed(1) + " t/s"),
											h("td", null, row.ttft === null ? "—" : row.ttft + " ms"),
											h(
												"td",
												{
													className: row.cost === null ? "tu-muted" : undefined,
													// 统一按界面币种显示；原始计价币种留在悬浮提示里，便于核对账单。
													title: row.cost === null ? undefined : fmtMoney(row.cost, row.costCurrency)
												},
												row.cost === null ? "—" : fmtMoney(currency === "USD" ? row.costUsd : row.costCny, currency)
											)
										)
									)
								)
							)
						),
				h(
					"div",
					{ className: "tu-pager" },
					h(
						"div",
						{ className: "tu-pagerInfo" },
						tr("logs.page").replace("{page}", String(logs.page)).replace("{pages}", String(pages)).replace("{total}", String(logs.total))
					),
					h(
						"button",
						{ type: "button", className: "tu-btn", disabled: logs.page <= 1, onClick: () => props.onPage(logs.page - 1) },
						tr("logs.prev")
					),
					h(
						"button",
						{ type: "button", className: "tu-btn", disabled: logs.page >= pages, onClick: () => props.onPage(logs.page + 1) },
						tr("logs.next")
					)
				)
			);
		}

		//#endregion

		//#region 入口组件

		/** 侧边栏底部按钮。 */
		function UsageButton(props) {
			const tr = translateOf(props);
			const state = useSyncExternalStore(panelState.subscribe, panelState.getSnapshot, panelState.getSnapshot);
			const wide = props.wide === true;
			return h(
				"button",
				{
					type: "button",
					className: "tu-entry" + (wide ? "" : " tu-entryIcon"),
					"aria-label": tr("button.open"),
					title: tr("button.open"),
					"aria-expanded": state.open ? "true" : "false",
					"data-open": state.open ? "true" : "false",
					onClick: () => panelState.toggle()
				},
				h(GaugeIcon, null),
				wide ? h("span", null, tr("button.open")) : null
			);
		}

		/** 全屏面板。 */
		function UsageDock(props) {
			const tr = translateOf(props);
			const state = useSyncExternalStore(panelState.subscribe, panelState.getSnapshot, panelState.getSnapshot);
			const language = useSyncExternalStore(languageStore.subscribe, languageStore.getSnapshot, languageStore.getSnapshot);
			const currency = currencyOf(language.active);
			const [overview, setOverview] = useState(null);
			const [trend, setTrend] = useState(null);
			const [heat, setHeat] = useState([]);
			const [logs, setLogs] = useState(null);
			const [models, setModels] = useState([]);
			const [range, setRange] = useState(30);
			const [trendRange, setTrendRange] = useState(30);
			const [page, setPage] = useState(1);
			const [filter, setFilter] = useState("");
			const [error, setError] = useState("");
			const [revision, setRevision] = useState(0);
			const [loading, setLoading] = useState(false);

			const bump = () => setRevision((value) => value + 1);

			// 基础数据：概览 + 模型列表 + 价格 + 日历
			useEffect(() => {
				if (!state.open) return undefined;
				let alive = true;
				setLoading(true);
				Promise.all([callApi("overview", { currency, days: range }), callApi("models")])
					.then(([overviewData, modelsData]) => {
						if (!alive) return;
						setOverview(overviewData);
						setModels(modelsData.models);
						setError("");
					})
					.catch((reason) => {
						if (alive) setError((reason instanceof Error ? reason.message : String(reason)) ?? "");
					})
					.finally(() => {
						if (alive) setLoading(false);
					});
				return () => {
					alive = false;
				};
			}, [state.open, revision, currency, range]);

			// 趋势
			useEffect(() => {
				if (!state.open) return undefined;
				let alive = true;
				callApi("trend", { days: trendRange, currency })
					.then((data) => {
						if (alive) setTrend(data.days);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [state.open, trendRange, revision, currency]);

			// 热力图
			useEffect(() => {
				if (!state.open) return undefined;
				let alive = true;
				callApi("heatmap", { weeks: 53, currency })
					.then((data) => {
						if (alive) setHeat(data.days);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [state.open, revision, currency]);

			// 日志
			useEffect(() => {
				if (!state.open) return undefined;
				let alive = true;
				callApi("logs", { page, pageSize: 50, model: filter })
					.then((data) => {
						if (alive) setLogs(data);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [state.open, page, filter, revision]);

			// 首次安装会在后台回填历史会话；没回填完就每 5 秒自刷一次，避免面板一直显示 0。
			useEffect(() => {
				if (!state.open || overview === null || overview.backfill?.done !== false) return undefined;
				const timer = setTimeout(() => setRevision((value) => value + 1), 5000);
				return () => clearTimeout(timer);
			}, [state.open, overview]);

			useEffect(() => {
				if (!state.open) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") panelState.close();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [state.open]);

			if (!state.open) return null;

			return h(
				"div",
				{ className: "tu-backdrop", onClick: () => panelState.close() },
				h(
					"div",
					{
						className: "tu-panel",
						role: "dialog",
						"aria-label": tr("panel.title"),
						onClick: (event) => event.stopPropagation()
					},
					h(
						"div",
						{ className: "tu-head" },
						h(
							"div",
							{ className: "tu-headMain" },
							h("div", { className: "tu-title" }, tr("panel.title")),
							h("div", { className: "tu-sub" }, tr("panel.subtitle"))
						),
						h("button", { type: "button", className: "tu-icon", "aria-label": tr("panel.close"), title: tr("panel.close"), onClick: () => panelState.close() }, h(CloseIcon, null))
					),
					h(
						"div",
						{ className: "tu-body" },
						error === "" ? null : h("div", { className: "tu-hint tu-errorColor" }, tr("error.load") + error),
						loading && overview === null ? h("div", { className: "tu-hint" }, tr("loading")) : null,
						overview !== null && overview.backfill?.done === false ? h("div", { className: "tu-hint tu-warn" }, tr("backfill.running")) : null,
						overview !== null && overview.pricingError ? h("div", { className: "tu-hint tu-errorColor" }, tr("error.pricing") + overview.pricingError) : null,
						h(
							"div",
							{ className: "tu-scope" },
							h("div", { className: "tu-scopeLabel" }, tr("range.label")),
							h(
								"div",
								{ className: "tu-seg", role: "group", "aria-label": tr("range.label") },
								RANGES.map((value) =>
									h(
										"button",
										{
											key: value,
											type: "button",
											className: "tu-segItem",
											"data-active": range === value ? "true" : "false",
											onClick: () => setRange(value)
										},
										rangeLabel(tr, value)
									)
								)
							)
						),
						h(StatCards, { tr, overview }),
						h(TrendSection, { tr, data: trend, range: trendRange, onRange: setTrendRange }),
						h(HeatmapSection, { tr, data: heat, currency, language: language.active }),
						h(LogsSection, {
							tr,
							data: logs,
							models,
							currency,
							filter,
							onFilter: (value) => {
								setFilter(value);
								setPage(1);
							},
							onPage: setPage
						})
					),
				)
			);
		}

		//#endregion

		/**
		 * 客户端插件体：侧边栏按钮 + 浮层面板。样式与字典都挂在 ctx.effect 上，随卸载回收。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-usage: dictionaries");
			// 语言切换后重算币种：直接订阅 locale 快照，而不是在每次渲染时去猜。
			const readActive = () => {
				try {
					return ctx.locale.getLocale?.().active ?? ctx.locale.getSnapshot?.().active ?? "en";
				} catch {
					return "en";
				}
			};
			languageStore.sync(readActive());
			ctx.effect(() => {
				if (typeof ctx.locale.subscribe !== "function") return () => {};
				return ctx.locale.subscribe(() => languageStore.sync(readActive()));
			}, "token-usage: language");
			ctx.effect(() => insertStyles(), "token-usage: styles");
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "token-usage", order: 31, locale: NS }, UsageButton)
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "token-usage", order: 46, locale: NS }, UsageDock)
			);
		}

		const inject = ["slots", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
