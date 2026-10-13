import { toSlashed } from "../utils/date";
export const CustomerDetail = ({ customer }: { customer: { createdAt: Date } }) => (
	<span>{toSlashed(customer.createdAt)}</span>
);
