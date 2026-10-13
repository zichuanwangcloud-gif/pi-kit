import { useState } from "react";
import { Menu } from "./ui/Menu";
import { t } from "../i18n";

/**
 * 订单列表右上角的工具栏。
 * 「批量下载」挂在「更多操作」下拉里 —— 这是客户反馈「找不到导出」的位置：
 * 它在二级菜单里，而列表页顶部有 6 个一级按钮，视觉上完全被淹没。
 */
export function OrderListToolbar({ onRefresh }: { onRefresh: () => void }) {
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<div className="toolbar">
			<button onClick={onRefresh}>{t("orders.toolbar.refresh")}</button>
			<button>{t("orders.toolbar.filter")}</button>
			<button>{t("orders.toolbar.batchAction")}</button>
			<Menu open={menuOpen} onToggle={() => setMenuOpen(!menuOpen)}>
				<MenuItem label={t("orders.toolbar.exportCsv")} href="/orders/export.csv" />
				<MenuItem label={t("orders.toolbar.archive")} />
			</Menu>
		</div>
	);
}
