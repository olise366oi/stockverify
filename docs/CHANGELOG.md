# CHANGELOG

## v0.3.4 — 限流绕过修复与 CORS 收紧

### 安全修复

- **P1 限流绕过**：`/api/v1/login` 无 rateLimit，攻击者绕过原 `/api/auth/login` 的 5 分钟 20 次限制直接打 v1 接口；现抽出 `security.js` 共享限流模块，按接口维度隔离计数（`legacy` / `v1-login`），并定期清理过期记录防内存泄漏

### 加固

- **CORS 收紧**：原 `cors()` 允许所有来源；现默认仅同源 + 开发环境 localhost，生产通过 `CORS_ORIGINS` 环境变量配置白名单

### 已知观察（未修复）

- v1 token 与原 token 可互相调对方接口（两个中间件逻辑相同，`v1:true` 标记未校验）。**不构成越权**（两边都有 requireRole/requireAdmin 校验），仅影响未来收紧 v1 权限的扩展性

## v0.3.3 — JWT 密钥管理修复（P0）

### 安全修复

- **P0 硬编码密钥**：`server.js` 和 `routes-v1.js` 各自含硬编码 `JWT_SECRET` fallback（`sg-inventory-pwa-secret-key-2024-change-in-production`），Public 仓库可被任意人读取。若部署环境未设置 `JWT_SECRET` 环境变量，攻击者可伪造 `role:'admin'` 的 token，绕过本次会话修复的全部权限防线
- 修复方式：抽出 `config.js` 统一密钥来源；`NODE_ENV=production` 且未设密钥时拒绝启动；开发环境使用启动时随机生成的临时密钥
- 引入 `dotenv` 依赖，支持从 `.env` 加载环境变量（此前 `.env.example` 形同摆设）

### 影响

- 所有已登录用户的 token 在部署新版本后失效，需重新登录
- 生产部署必须显式设置 `JWT_SECRET`（>= 32 字符），否则服务拒绝启动

## v0.3.2 — 权限修复与 SEO 优化

### 安全修复

- **P0 跨租户越权修复**：`/api/v1/logs` 缺少 `WHERE shop_id = ?`，任意登录用户可读取全库所有店铺的审计日志；现已按 `req.user.shopId` 过滤
- **P1 权限降级修复**：`/api/v1/logs` 和 `/api/v1/export/excel` 仅校验 token 未校验角色，staff 可访问；现限制为 `requireRole('merchant','brand','admin')`

### 已知限制

- `/api/v1/logs` 现按 `req.user.shopId` 严格隔离，**admin 账号也只能查看自己所属店铺的日志**。admin 跨店查看能力（对齐原 `/api/logs` 的 `resolveShopScope` 语义）推迟至 v0.4.0，需先引入 `superadmin` 角色与独立跨店接口
- 初始数据里 `admin_01..05` 挂载在「系统管理端/运营管理端」等虚拟店铺上，本身是数据设计问题，与本次越权修复无关，另行处理

### SEO / 质量

- `public/index.html` 补充 `meta description`
- 新增 `public/robots.txt`（`Disallow: /admin.html`、`/api/`）
- README 补充 Lighthouse 实测分数与离线验证结论

## v0.3.1 — PWA 稳定性与审查修复

### 修复

- Service Worker：修复离线导航回退 bug（`caches.match` 返回 Promise 恒真，导致 `/admin.html`、`/register.html` 离线时白屏）；改为缓存优先 + 后台更新策略
- server.js：安全头中间件移到 `express.static` 之前，静态资源现在能拿到 HSTS / X-Content-Type-Options / X-Frame-Options

### 优化

- manifest.json：图标拆分 any / maskable，新增 `scope` 和 `id` 字段，`start_url` 加 `?source=pwa`
- index.html：移除 3 个无效缓存 meta（Cache-Control / Pragma / Expires），viewport 去掉 `user-scalable=no`（无障碍），新增 `viewport-fit=cover`（刘海屏适配）
- server.js：静态资源分级缓存——HTML 和 sw.js `no-cache`，带版本号的 js/css/图片 `immutable` 长缓存
- README：补充首屏截图与技术栈徽章
- 版本号统一至 v0.3.0 起

## v0.2.0（2026-10-05）— 账号体系与参数管理端化、多国/多地区通用化

### 新增

- 登录改为**用户名 + 密码**（bcrypt 哈希存储于 `users.password_hash`，10 轮盐）：`/api/v1/login` 只收 `{ username, password, role? }`，登录页与管理端登录页均为「用户名 + 密码」两输入框，头部显示店铺名 + 当前账号；原登录链路保留不动。
- 初始账号：4 家合作商铺（`orchard_owner` / `jurong_owner` / `tampines_owner` / `suntec_owner`）+ 管理端 `admin_01` + 品牌方 `brand_01`，见 `docs/INIT.md`。
- 管理端**商品管理**：新增 / 编辑 / 上架 / 下架商品，字段含 SKU、名称、分类、售价、成本价、库存、状态；后端新增 `/api/v1/admin/products` 增删改接口（需管理端权限）。
- 管理端**系统设置**页（原「财务设置」扩展为 12 项）：国家/地区、货币代码、货币符号、税种名称、税率、平台/商家分成比例、佣金率、佣金附加税率、售价是否含税开关、佣金附加税开关、财务公式说明文本，写入 `settings` 表（key-value）；`finance.js` 改为从数据库读参数，`config.json` 仅作默认值。
- **多国/多地区通用化**：产品名去 SG（`stockverify-sg` → `stockverify`，对外统一为 **StockVerify · 多国零售核销与税务对账系统**）；`finance.js` 支持「售价含税 / 售价不含税」双口径（不含税基数 = 售价 ÷ (1+税率) / 售价）；货币代码、货币符号、税种名全部读系统设置，前端 13 处 + 管理端 33 处 `S$` 硬编码改为动态 `CUR`；登录页/报表页/Excel 表头（服务端与客户端导出）动态显示当前国家/货币/税种。
- 开户链路：品牌 / 商家 / 管理端新开账号时即创建用户并写入 bcrypt 初始密码（初始密码 = 开户密钥），新账号可直接用用户名 + 密码登录。
- GitHub 本地化：`.gitignore`、`.env.example`、`server.js` 读取 `process.env.PORT`、数据库路径读取 `process.env.DATABASE_PATH`。

### 变更

- 财务参数由「config.json 写死」改为「管理端可配置（settings 表优先，config.json 兜底）」；`settings` 表旧键迁移为新键（`gst_rate → tax_rate`、`price_includes_gst → price_includes_tax`、`commission_apply_gst → commission_apply_tax`，旧值自动搬运后删除旧键）；`config.json` 结构调整为 `finance.*` + `scan.*`，键与 settings 表一一对应。原有交易算法（读 `shops` 表店铺级参数）不受影响。
- `users` 表新增 `password_hash` 列与用户名唯一索引；`product_catalog` 表新增 `sku`、`category` 列；`shops` 表相关注册接口审计文案更新。
- 品牌与文案：`package.json` name → `stockverify`；manifest、页面 title、i18n、footer、server 启动横幅全部更新为 StockVerify 多国定位；示例数据保留新加坡零售品类并标注「演示数据」。
- README 顶部新增版本声明：「当前版本 v0.2.0，功能持续迭代中，部分模块（发货管理、推送通知）仍在规划」。
- 全局清理「卡密 / demo / 演示 / 阶段 / 豆包」字样（UI、i18n、manifest、README、docs）；原登录接口功能与鉴权逻辑保持不变。

### 1.7 验证矩阵（已通过）

- 管理端切换 Malaysia / MYR / SST / 0.06 / 售价含税 → 扫码按 6% 口径计算（SST 表头）✅
- 改回 Singapore / SGD / GST / 0.09 / 售价含税 → 恢复 9% 口径（GST 表头）✅
- 原 `/api/*` 接口与 `/api/transactions/*` 算法未动 ✅

## v0.1.1（2026-10-05）— 商业化改造

品牌统一为 **StockVerify SG**（面向新加坡零售商铺的扫码核销与 GST 对账系统），仅改命名、数据与包装，业务逻辑不变。

### 新增

- `routes-v1.js`：API v1 接口模块（`/api/v1/*`），含 hello / login / products / scan/in / scan/out / sync / logs / export/excel / config，服务端 5 秒防重 + clientRecordId 判重 + 设备信息写日志。
- `config.json`：全部配置外置（GST 9% 售价含 GST、7:3 分成、佣金 3% + 附加 GST、防重窗口 5000ms）。
- `finance.js`：财务计算模块，从配置文件读参数。
- `public/offline.html`：离线提示页（Service Worker 断网回退）。
- 合作商铺数据：Orchard Central / Jurong Point / Tampines Mall / Suntec City 四店开户密钥与 36 个新加坡零售品类商品。

### 变更

- 品牌重命名：`package.json` → `stockverify-sg`；manifest、页面 title、i18n 文案、字标（`img/stockverify-logo.png`）全部更新为 StockVerify SG。
- 接口路径：旧前缀接口统一为 `/api/v1/*`（路由文件更名为 `routes-v1.js`），功能与返回不变。
- 开户密钥格式：`SV-SG-XXXX-XXXX`（4 段大写字母+数字），原密钥全部替换。
- 数据真实化：店铺中性化改名、商品替换为新加坡零售品类（药品/食品/日用品，S$2.5–28，真实 SKU）、商品模板与一物一码实例名称同步。
- 售价/成本改为读取商品档案（`products.sell_price` / `cost_price`），商品新增/编辑接口接受售价字段。
- 库存列表 API（`/api/merchant/catalog-summary`）返回真实售价。
- 日志哈希链公式统一（追加与校验一致），历史日志按统一公式重算，`/api/logs/verify` 校验通过。
- 文档：README 重写为产品文档；`docs/项目现状.md` 同步更新。

### 修复

- 审计日志哈希链校验失败问题（追加公式含时间戳、校验公式不含，二者不一致导致历史数据校验失败）：统一为 `sha256(店铺|用户|动作|目标|备注|上一哈希)`。

## v0.1.0（2026-10-05）— 系统初始版本

基于原系统能力整理的首个正式版本基线：

- 登录（JWT）、扫码入库/出库、离线模式（IndexedDB + Service Worker + window online 补传，兼容 iOS Safari）、GST 自动计算、7:3 分成、前端 Excel 导出、操作日志（哈希链）、商品管理、角色权限、多店铺隔离、品牌方发货/进货/折扣审核链路。
- 前端 PWA：manifest（standalone）+ Service Worker 应用外壳缓存 + 离线提示。
- 数据库：SQLite 12 张表（shops / users / products / transactions / audit_logs / purchase_orders / shipments / shipment_items / product_catalog / product_catalog_auth / product_catalog_region / product_items）。

> 数据备份：`backup-phase1`（v0.1.0 前逐文件）、`backup-phase1.5`（v0.1.1 前全量）、`backup-phase1.6`（v0.2.0 前全量）。
