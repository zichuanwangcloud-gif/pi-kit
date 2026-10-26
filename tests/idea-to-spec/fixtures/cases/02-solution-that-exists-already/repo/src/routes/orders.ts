import { Router } from "express";
import { exportOrdersCsv, listOrders } from "../services/orders";

export const ordersRouter = Router();

ordersRouter.get("/orders", async (req, res) => {
	const page = Number(req.query.page ?? 1);
	res.json(await listOrders({ page, pageSize: 20 }));
});

// 前端「更多操作 → 批量下载」调用的就是这个接口。
// 同步生成 CSV 并直接作为响应体返回，没有条数上限。
ordersRouter.get("/orders/export.csv", async (req, res) => {
	const csv = await exportOrdersCsv({ tenantId: req.user.tenantId });
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
	res.send(csv);
});
