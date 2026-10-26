import { Router } from "express";
import { listSettlements } from "../services/settlement";

export const settlementRouter = Router();

// 结算列表接口，只能读当前登录租户的数据 —— 没有对外导出的能力。
settlementRouter.get("/settlements", async (req, res) => {
	res.json(await listSettlements({ tenantId: req.user.tenantId, month: req.query.month }));
});
