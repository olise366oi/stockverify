# StockVerify

**面向多国零售分销的库存 / 销售管理系统（PWA）**

![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js) ![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8) ![Lighthouse](https://img.shields.io/badge/Lighthouse-97%2F97%2F100%2F100-22c55e) ![version](https://img.shields.io/badge/version-v0.3.4-blue)

![登录页](docs/screenshots/01-login.png)

覆盖总代 → 代理 → 商家多级分销链路：商品库分层授权、发货与进货、扫码核销、库存管理、分成对账、审计留痕，完整闭环。断网时记录自动入本地队列、联网补传；多国税制与货币由管理端配置；操作日志以 SHA-256 哈希链防篡改。

一个可直接安装到手机桌面的渐进式 Web 应用（PWA）。

## 核心亮点

- 🌐 **多级授权链路** — 商品目录按 总代 → 代理 → 商家 分层授权（`authorized_by` + `level`）；撤销授权递归级联删除全部下游，授权树按角色服务端过滤返回
- 📦 **商品库与分销管理** — 总代上新 → 逐级授权 → 商家经营；发货单、进货单、商品条目全链路追踪
- 📷 **扫码核销** — 手机摄像头扫商品条码完成入库/出库，无需专用扫码枪
- 📴 **离线不丢** — 断网时记录存 IndexedDB，联网后自动补传，一条不丢（兼容 iOS Safari，不依赖 Background Sync）
- 🌏 **多国税制** — 国家 / 货币 / 税种 / 税率全部可配置，支持含税与不含税双口径
- 🔐 **多租户隔离** — 所有查询按店铺强制过滤，跨店访问由服务端 403 拦截
- 🧾 **一键对账** — 导出 Excel 报表，含平台/商家分成、佣金与佣金附加税
- 🔗 **防篡改审计** — 操作日志以 SHA-256 哈希链存储，任何改动可校验

## 截图

| 登录 | 首页 | 扫码入库 |
|:----:|:----:|:--------:|
| ![](docs/screenshots/01-login.png) | ![](docs/screenshots/02-home.png) | ![](docs/screenshots/03-scan-in.png) |
| **扫码出库** | **库存管理** | **离线模式** |
| ![](docs/screenshots/04-scan-out.png) | ![](docs/screenshots/05-inventory.png) | ![](docs/screenshots/06-offline.png) |
| **对账报表** | **操作日志** | **管理端商品** |
| ![](docs/screenshots/07-report.png) | ![](docs/screenshots/08-logs.png) | ![](docs/screenshots/10-admin-products.png) |

## 技术栈

**后端** — Node.js ≥ 20 · Express · SQLite（node-sqlite3-wasm）· JWT · bcrypt · ExcelJS

**前端** — 原生 HTML / CSS / JavaScript（无框架）· html5-qrcode · SheetJS · IndexedDB

**PWA** — Web App Manifest · Service Worker · 离线回退 · 可安装到桌面

**权限模型** — JWT + RBAC（staff / merchant / brand / admin）· 商品目录多级授权链路 · 服务端 403 拦截

## 快速开始

```bash
git clone https://github.com/olise366oi/stockverify.git
cd stockverify
npm install
npm start           # 打开 http://localhost:3000
```

初始账号见 [docs/INIT.md](docs/INIT.md)。

## 质量指标（Lighthouse 实测）

| 类别 | 分数 |
|------|------|
| Performance | 97 |
| Accessibility | 97 |
| Best Practices | 100 |
| SEO | 100 |

PWA 可安装性 — installable-manifest ✅ · maskable-icon ✅ · splash-screen ✅ · themed-omnibox ✅

离线验证（Playwright 自动化） — 断网访问已缓存页面正常返回；无缓存的导航回退 offline.html

## 安全设计

| 层面 | 措施 |
|------|------|
| 认证 | JWT（12h）+ bcrypt 哈希；登录限流 5 分钟 20 次（v1 与原接口独立计数） |
| 密钥管理 | JWT_SECRET 生产环境强制校验，缺失则拒绝启动；不硬编码 |
| 多租户 | 所有查询带 WHERE shop_id = ?；越权访问由服务端 403 拦截 |
| 角色权限 | requireRole / requireAdmin 服务端强校验；staff 无法访问商家/管理接口 |
| 商品授权链路 | 总代 → 代理 → 商家分层授权，撤销递归级联删除下游；授权树按角色服务端过滤返回 |
| 传输 | 强制 HTTPS（301）· HSTS · X-Content-Type-Options · X-Frame-Options |
| CORS | 默认仅同源，生产通过 CORS_ORIGINS 环境变量配置白名单 |
| 审计 | 操作日志 SHA-256 哈希链，/api/logs/verify 可校验完整性 |
| 上传 | 图片类型白名单 · 3MB 上限 · 随机文件名 · nosniff |

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构说明
- [docs/offline-sync.png](docs/offline-sync.png) — 离线同步流程图
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 变更记录

<details>
<summary><b>API 接口清单</b>（点击展开）</summary>

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/v1/login | 登录取 token |
| GET | /api/v1/products | 商品列表（按店铺过滤） |
| POST | /api/v1/scan/in | 扫码入库 |
| POST | /api/v1/scan/out | 扫码出库 |
| POST | /api/v1/sync | 离线记录补传 |
| GET | /api/v1/logs | 操作日志（店铺过滤 + 角色限制） |
| GET | /api/v1/export/excel | 导出对账报表 |
| GET | /api/v1/config | 业务配置（公开，无隐私） |
| GET / PUT | /api/v1/admin/settings | 系统设置（需 admin） |
| GET / POST / PUT / PATCH | /api/v1/admin/products | 商品管理（需 admin） |

</details>

<details>
<summary><b>环境变量</b>（点击展开）</summary>

```bash
PORT=3000                       # 服务端口（默认 3000）
JWT_SECRET=<32+字符随机串>       # 【生产必填】缺失则拒绝启动
NODE_ENV=production             # 生产标识，启用 JWT_SECRET 强制校验
CORS_ORIGINS=                   # CORS 白名单（逗号分隔；留空仅同源）
DATABASE_PATH=data/inventory.db # SQLite 路径（可选）
```

生成 JWT_SECRET：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

项目使用 dotenv 加载 .env；.env 已在 .gitignore 中排除。

</details>

<details>
<summary><b>目录结构</b>（点击展开）</summary>

```text
server.js        Express 入口、中间件、传统 /api/* 路由
routes-v1.js     API v1 路由（/api/v1/*）
config.js        环境变量与 JWT_SECRET 管理
security.js      共享限流模块（按接口维度隔离计数）
database.js      SQLite 初始化、审计链写入与校验
finance.js       税制 / 分成 / 佣金计算
public/          PWA 前端（HTML / CSS / JS / sw.js / manifest.json）
docs/            架构说明、CHANGELOG、截图
```

</details>

## 版本

当前版本 v0.3.4 — 变更记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
