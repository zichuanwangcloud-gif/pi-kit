// 项目里没有统一的日期格式化函数，各页面各写各的。
export function toIso(d: Date) {
	return d.toISOString().slice(0, 10);
}
export function toSlashed(d: Date) {
	return d.toLocaleDateString("en-US");
}
