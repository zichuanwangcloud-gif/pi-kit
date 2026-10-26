import { db } from "../db";

// 列表首屏查询：对 created_at 做范围扫描，但没有复合索引，
// 早高峰并发上来后这条查询会退化成全表扫描。
export async function listOrders({ tenantId, page }: { tenantId: string; page: number }) {
	return db.query(
		`SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20 OFFSET $2`,
		[tenantId, (page - 1) * 20],
	);
}
