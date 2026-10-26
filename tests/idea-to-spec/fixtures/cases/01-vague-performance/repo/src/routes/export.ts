import { Router } from "express";
import { buildOrdersCsv } from "../services/export";

export const exportRouter = Router();

// 对账用导出：同步把全量订单拼成 CSV，一次性塞进响应体。
// 没有分页、没有上限、没有流式写出 —— 大账号会在这里超时。
exportRouter.get("/orders/export.csv", async (req, res) => {
	const csv = await buildOrdersCsv({ tenantId: req.user.tenantId });
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.send(csv);
});
