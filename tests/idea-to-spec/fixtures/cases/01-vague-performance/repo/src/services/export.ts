import { db } from "../db";

// 逐条取客户名，N+1；全量结果先在内存里拼成一个大字符串再返回。
export async function buildOrdersCsv({ tenantId }: { tenantId: string }) {
	const orders = await db.query("SELECT * FROM orders WHERE tenant_id = $1", [tenantId]);
	const rows = ["订单号,客户,金额,下单时间"];
	for (const order of orders) {
		const customer = await db.query("SELECT name FROM customers WHERE id = $1", [order.customerId]);
		rows.push([order.no, customer.name, order.amount, order.createdAt].join(","));
	}
	return rows.join("\n");
}
