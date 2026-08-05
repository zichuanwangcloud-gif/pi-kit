# Gate 审阅清单参考

本文件是 `SKILL.md` 中 Gate 1.1（静态代码审阅）与 Gate 3.1/3.2/3.3（安全）的完整清单。判定标准（什么算 PASS/FAIL/BLOCKED）保留在 `SKILL.md`，本文件只提供检查项与工具细则。

## Gate 1.1 静态代码审阅清单

沿变更调用链检查：

- 条件、边界、错误处理、空值、并发、事务、资源释放
- API/schema/配置兼容性
- migration 前后兼容与回滚风险
- 缓存、重试、幂等和异步一致性
- 测试是否断言行为而非只执行代码
- 测试是否会在旧实现上失败，是否覆盖核心分支和回归点
- mock 是否掩盖真实集成错误

发现必须附 `file:line`、触发条件、实际影响和建议修复方向。

## Gate 3.1 威胁建模与人工审阅（12 项）

按改动面检查适用项：

1. 身份认证、授权、租户/对象级权限、默认拒绝
2. SQL/NoSQL/命令/模板/LDAP 等注入
3. XSS、CSRF、SSRF、开放重定向
4. 路径穿越、任意文件读写、解压穿越
5. 不安全反序列化、动态执行、shell 拼接
6. secret、token、私钥、日志敏感信息、错误响应泄露
7. 密码学、随机数、签名/证书校验
8. webhook、回调、上传、URL fetch 和第三方 API
9. 依赖、CI workflow、容器、IaC 和权限范围变化
10. DoS、无界输入、资源耗尽、压缩炸弹
11. 竞态、TOCTOU、事务边界和安全状态失配
12. 调试后门、feature flag 默认值、绕过路径

只报告 PR 新增或显著恶化的问题；既存问题可列为观察项，并明确不是本 PR 引入。

## Gate 3.2 Secret 扫描细则

优先运行项目已配置工具，如 gitleaks、detect-secrets、trufflehog 的仓库模式。扫描范围必须覆盖：

- `base...head` diff
- PR commits（避免最终 diff 删除但历史仍含 secret）

细则：

- 如果没有项目工具，可对 diff 做高置信模式和熵线索审阅，但不得把简单 grep 表述成完整 secret scanner。
- 发现疑似真实 secret 时不要在报告中复述完整值，只给文件、行和脱敏指纹；Gate 至少 `FAIL`，并建议轮换。
- secret 扫描是快速档也必须执行的项，不可省略。

## Gate 3.3 SAST 与依赖扫描

从项目配置发现并运行已有工具，例如：

- Semgrep、CodeQL 本地配置、Sonar scanner
- `gosec`、`cargo audit`、Bandit、Brakeman
- `npm/pnpm/yarn audit`、`pip-audit`、`govulncheck`、OSV scanner
- IaC/container scanner（项目已配置且改动相关时）

规则：

- 遵守 `SKILL.md` Phase 0 的工具安装边界：不做全局下载或安装来凑扫描覆盖。
- 项目明确要求的 scanner 缺失/无法运行 → Security `BLOCKED`。
- 项目没有专用 scanner → 完成人工 diff 安全审阅，并运行当前环境已有且与项目可信配置一致的工具；报告"扫描覆盖有限"。若无未验证高风险面，可以 `PASS`，但必须在报告的"未验证项"中写明覆盖限制。
- 依赖网络失败记为工具 `BLOCKED`，不伪装成"无漏洞"。
- 审计新增依赖时区分 direct/transitive、runtime/dev 和漏洞是否可达；不能只粘贴 audit 数量。
- scanner finding 必须去重、验证上下文并标记 true/false positive，不能原样照搬。
