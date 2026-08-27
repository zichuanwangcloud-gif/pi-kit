# 威胁类别查表与扫描器目录

按改动类型反查该看哪些威胁类别、哪些 sink、用哪些既有扫描器，以及 finding 怎么处理。

> 由 SKILL.md 的 Gate 3.3、Gate 3.4、Gate 3.5 引用。

## 本文小节

- [用法](#用法)
- [按改动类型反查](#按改动类型反查)
- [威胁类别与典型 sink](#威胁类别与典型-sink)
- [Secret 扫描](#Secret-扫描)
- [SAST 与依赖扫描](#SAST-与依赖扫描)
- [finding 处理](#finding-处理)

## 用法

本文件是**查表工具，不是必须逐条勾选的清单**。Gate 3 的判据是「偏离本仓库既定安全实践」
和「本 PR 触及的数据流」，不是「这张表有没有全绿」。

用法：先在「按改动类型反查」定位本 PR 的改动类型，只展开对应的威胁类别；
表里与本 PR 无关的行不写进报告，也不写成「不适用」占位。

仓库自己有更严格的既定约定（`SECURITY*`、`AGENTS.md`、安全 lint 规则）时，以仓库约定为准，
本表只做补漏。

## 按改动类型反查

| 改动类型 | 优先展开的威胁类别 |
|---|---|
| 新增/修改 HTTP 端点、路由 | 鉴权与对象级权限、注入、SSRF、开放重定向、无界输入 |
| 表单、渲染、模板、前端组件 | XSS、CSRF、模板注入、仅前端校验 |
| SQL / ORM / 查询构造 | SQL/NoSQL 注入、越权查询（缺租户条件）、批量导出 |
| 文件上传、下载、导出、压缩 | 路径穿越、任意文件读写、解压穿越、内容类型混淆、压缩炸弹 |
| 反序列化、动态执行、shell 调用 | 不安全反序列化、命令注入、shell 拼接、eval |
| 认证、会话、密码、令牌 | 认证绕过、会话固定、令牌有效期与撤销、密码学与随机数 |
| webhook、回调、第三方 API | 签名/证书校验、重放、SSRF、响应数据信任 |
| 日志、错误处理、监控上报 | secret 与 PII 泄露、错误响应泄露内部结构 |
| 配置、feature flag、环境变量 | 不安全默认值、调试后门、绕过路径、生产/测试配置混用 |
| 依赖、lockfile | 已知漏洞、可达性、direct/transitive、供应链与安装脚本 |
| CI workflow、容器、IaC | 权限范围扩大、密钥暴露给不可信触发器、镜像与网络策略 |
| 异步任务、队列、事务 | 竞态、TOCTOU、事务边界、安全状态失配、重复消费 |
| migration、schema | 数据可见性变化、默认权限、回滚后的数据暴露 |

## 威胁类别与典型 sink

| 威胁类别 | 关键检查点 | 典型 sink / 触发面 |
|---|---|---|
| 认证与授权 | 默认拒绝、对象级与租户级判定点、角色提升路径 | 中间件、装饰器、策略引擎、直接 ID 查询 |
| 注入 | 是否参数化、是否绕过既有查询封装 | SQL/NoSQL 语句、命令行、模板、LDAP、XPath |
| XSS / CSRF / SSRF / 重定向 | 自动转义是否被关闭、目标 URL 是否白名单 | `innerHTML`、`dangerouslySetInnerHTML`、HTTP 客户端、`Location` |
| 路径与文件 | 规范化后是否仍在允许根内、符号链接 | 文件读写、归档解包、静态资源服务 |
| 反序列化与动态执行 | 输入是否可控、类型是否白名单 | pickle/yaml/序列化框架、`eval`、反射、插件加载 |
| Secret 与敏感数据 | 是否进入日志、响应、错误栈、缓存 | 日志、APM、响应体与响应头、异常上报、构建产物 |
| 密码学 | 算法与模式、密钥来源、随机数来源、签名与证书校验 | 加解密封装、JWT、TLS 客户端配置 |
| 依赖与供应链 | 新增依赖来源、安装脚本、可达性 | lockfile、安装钩子、CI 缓存 |
| DoS 与资源 | 输入是否有上界、是否有超时与配额 | 循环、正则、并发、内存分配、外部调用 |
| 并发与状态 | 检查与使用之间是否可变、事务是否覆盖安全判定 | 缓存、幂等键、状态机、乐观锁 |

## Secret 扫描

优先运行项目已配置的工具，例如 `gitleaks`、`detect-secrets`、`trufflehog` 的仓库模式。
扫描范围必须同时覆盖：

- `base...head` 的最终 diff
- PR 的全部 commits（最终 diff 已删除、但历史仍含 secret 的情况必须发现）

没有项目工具时，可对 diff 做高置信模式与熵线索审阅，但**不得**把简单 grep 表述成完整
secret scanner，必须在报告里写明覆盖限制。

发现疑似真实 secret 时：报告中不复述完整值，只给文件、行号与脱敏指纹（例如前 4 位 + 长度）；
Gate 至少 `FAIL`，并建议立即轮换。

## SAST 与依赖扫描

从项目配置发现并运行已有工具，例如：

- Semgrep、CodeQL 本地配置、Sonar scanner
- `gosec`、`cargo audit`、Bandit、Brakeman
- `npm/pnpm/yarn audit`、`pip-audit`、`govulncheck`、OSV scanner
- IaC / container scanner（项目已配置且与改动相关时）

发现工具配置的证据来源：CI workflow、pre-commit 配置、Makefile/Taskfile、
`.semgrep*` / `.gitleaks*` / `codeql*` 等配置文件、贡献与安全文档。

新增依赖必须区分 direct / transitive、runtime / dev，以及漏洞在本项目调用路径上**是否可达**；
只粘贴 audit 的漏洞计数不算证据。

## finding 处理

| 情况 | 记法 |
|---|---|
| 工具运行成功、无 finding | 记工具名、版本、范围与「无 finding」 |
| 工具运行失败、网络失败、缺依赖 | 记为工具 `BLOCKED`，绝不写成「无漏洞」 |
| 项目明确要求的 scanner 缺失或无法运行 | Security `BLOCKED` |
| 项目没有专用 scanner | 完成人工审阅 + 环境已有且与项目可信配置一致的工具，报告「扫描覆盖有限」；无未验证高风险面时可 PASS，但评级上限 A |
| scanner 报出 finding | 去重、结合上下文验证、标注 true / false positive 与判定理由 |

不自动全局安装或下载未知 scanner；不执行 PR 中新增且未经阅读的扫描脚本。
