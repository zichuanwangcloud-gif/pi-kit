import { Router } from "express";
import { verifyPassword } from "../services/auth";

export const loginRouter = Router();

// 登录：失败后没有任何计数或限流，可以无限次重试。
loginRouter.post("/login", async (req, res) => {
	const { email, password } = req.body;
	const user = await verifyPassword(email, password);
	if (!user) return res.status(401).json({ error: "invalid credentials" });
	res.json({ token: user.token });
});
