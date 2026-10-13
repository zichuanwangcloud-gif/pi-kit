import { toIso } from "../utils/date";
export const OrderDetail = ({ order }: { order: { createdAt: Date } }) => (
	<span>{toIso(order.createdAt)}</span>
);
