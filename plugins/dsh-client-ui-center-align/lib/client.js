window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-center-align",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 修复侧边栏图标 vs 文字的视觉错位：
		// 1) 图标按钮里 svg 14-16px，文字 22px，中心对齐后图标顶部低于文字顶部
		//    约 4px，看起来图标小、文字大、上下不齐。把图标 svg 放大到 22x22
		//    （viewBox 16x16 等比 → 内容占满、不裁剪）。
		// 2) 顶部 brand：中间层 .hHd-Xa_brandIdentity 是 flex row，
		//    align-items: center 让 logo(17.65) 和文字(24) 中心对齐，
		//    logo 顶 y=27、底 y=44.825，文字顶 y=24、底 y=48，
		//    logo 顶部比文字低 3px、底部比文字高 3px，视觉下沉。
		//    改为 flex-start 让两者顶部都对齐 y=24。
		const NS = "centerAlign";
		const inject = [];

		const CSS = `
/* 侧边栏带文字的图标按钮：图标放大到与文字等高（22px） */
.hHd-Xa_newSession svg,
.VOzbGW_trigger svg {
	width: 22px !important;
	height: 22px !important;
	display: block;
}

/* 侧边栏顶部 brand：中间 row 容器顶部对齐，让 logo 与文字顶部齐平 */
.hHd-Xa_brandIdentity {
	align-items: flex-start !important;
}
`;

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-source", "dsh-client-ui-center-align");
				style.textContent = CSS;
				document.documentElement.appendChild(style);
				return () => { if (style.parentNode) style.parentNode.removeChild(style); };
			}, "ui-center-align: inject align styles");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
