# StockVerify SG · 新加坡零售核销与对账系统

> 面向新加坡零售商铺的扫码核销与 GST 对账系统（PWA）
>
> 用户名密码登录 · 扫码出入库 · 离线不丢记录 · GST 自动计算 · 7:3 分成 · Excel 对账报表 · 操作留痕

## 项目简介

StockVerify SG 为新加坡零售商铺提供「扫码核销 + 财务对账」的一体化解决方案：

- 每个商铺持独立账号（用户名 + 密码，bcrypt 哈希存储）登录，数据按店铺完全隔离；
- 店员用手机摄像头扫码完成**入库/出库**，库存实时增减；
- **离线断网**时扫码记录先存本地（IndexedDB），联网后自动补传，一条不丢；
- 财务侧按**售价含 GST** 口径自动计算不含税基数、GST、平台/商家 7:3 分成与佣金附加 GST，参数由管理端在「财务设置」页维护；
- 一键导出 **Excel 对账报表**，操作日志以 SHA-256 哈希链防篡改，可审计。

## 功能列表

| 功能 | 说明 |
|------|------|
| 账号登录 | 用户名 + 密码（bcrypt 哈希），JWT 认证；原登录链路保留 |
| 入库扫码 | 手机摄像头扫商品条码，确认数量后库存自动增加 |
| 出库扫码 | 售出扫码确认，库存自动扣减，附财务预览 |
| 离线模式 | 断网时记录存 IndexedDB，联网自动补传（含 iOS Safari） |
| 待上传提示 | 页面顶部实时显示「网络已断开 / 待上传 X 条」 |
| GST 自动计算 | 不含税基数、GST、7:3 分成、佣金附加 GST 全自动 |
| 财务设置 | 管理端可视化配置 GST 税率 / 分成比例 / 佣金率（存 settings 表） |
| 商品管理 | 管理端可新增 / 编辑 / 上架 / 下架商品（SKU、名称、分类、售价、成本、库存、状态） |
| Excel 对账 | 服务端生成「汇总统计 + 交易明细」双工作表报表 |
| 操作日志 | 账号、时间、商品、动作、数量、设备信息全留痕，哈希链防篡改 |
| 扫码防重复 | 同店铺同商品同类型 5 秒窗口拦截（前后端双重） |
| 多店铺隔离 | 不同账号 = 不同店铺，数据完全隔离 |
| 角色权限 | 商家 / 店员 / 品牌方 / 管理端四级角色 |
| 品牌链路 | 品牌方发货单、进货申请、折扣审核（品牌方/管理端） |
| 强制 HTTPS | 生产环境自动跳转 HTTPS，禁止 HTTP |

## 技术栈

- **后端**：Node.js + Express + SQLite（node-sqlite3-wasm）
- **前端**：原生 HTML/CSS/JavaScript（无框架）
- **PWA**：Web App Manifest + Service Worker（应用外壳离线缓存）
- **离线存储**：IndexedDB + `window online` 事件监听（兼容 iOS Safari，不依赖 Background Sync）
- **扫码**：html5-qrcode
- **服务端报表**：ExcelJS；**客户端导出**：SheetJS（xlsx）
- **认证**：JWT Token + bcrypt 密码哈希
- **日志防篡改**：SHA-256 哈希链（追加与校验公式一致）

## 本地运行步骤

```bash
# 1. 安装依赖（Node.js ≥ 20）
npm install

# 2. 启动服务（默认端口 3000，可用环境变量 PORT 覆盖）
npm start
```

启动成功后浏览器访问：<http://localhost:3000>

- 电脑访问：`http://localhost:3000`
- 手机同局域网访问：`http://<本机IP>:3000`（摄像头扫码需 HTTPS 或 localhost）

初始账号见 [docs/INIT.md](docs/INIT.md)。

## API 文档（/api/v1/*）

工程化接口统一挂载于 `/api/v1/` 前缀，与原有 `/api/*` 接口（`/api/auth/login`、`/api/products`、`/api/transactions/*`、`/api/logs` 等）并存、互不影响。

### 财务公式（口径：售价含 GST；参数来自数据库 settings 表，config.json 仅作默认值）

| 字段 | 公式 | 说明 |
|---|---|---|
| 不含税成交基数 | 售价 ÷ (1 + GST税率) | 从含税售价倒推（默认税率 9%） |
| GST | 不含税基数 × GST税率 | |
| 含税总额 | 不含税基数 + GST | 应等于售价 |
| 平台分成 | 不含税基数 × 平台比例（默认 70%） | 7/3 分成，管理端可配置 |
| 商家分成 | 不含税基数 × 商家比例（默认 30%） | |
| 佣金 | 不含税基数 × 佣金率（默认 3%） | 管理端可配置 |
| 佣金附加 GST | 佣金 × GST税率 | 可开关 |

示例（默认参数）：售价 S$6.50、数量 2 → 不含税基数 11.93、GST 1.07、含税总额 13.00、平台分成 8.35、商家分成 3.58、佣金 0.36、佣金 GST 0.03。

### 接口清单

| 方法 | 路径 | 参数（JSON） | 说明 |
|---|---|---|---|
| GET | `/api/v1/hello` | 无 | 健康检查：`{ "message": "后端服务器运行正常！" }` |
| POST | `/api/v1/login` | `{ username, password, role? }` | 用户名 + 密码登录（bcrypt 校验），返回 JWT token + 店铺/用户信息 |
| GET | `/api/v1/products` | Header: `Authorization: Bearer <token>` | 当前店铺商品列表 |
| POST | `/api/v1/scan/in` | `{ productId, qty, deviceInfo? }` | 入库扫码：库存增加，写流水 + 日志 |
| POST | `/api/v1/scan/out` | `{ productId, qty, deviceInfo? }` | 出库扫码：校验库存后扣减，写流水 + 日志 |
| POST | `/api/v1/sync` | `{ records: [{ productId, qty, type: in/out, clientRecordId?, clientTimestamp?, deviceInfo? }] }` | 离线补传：逐条写库，按 clientRecordId 判重 |
| GET | `/api/v1/logs` | 同上 Header | 最近 200 条操作日志（含账号、时间、商品、动作、数量、设备信息、哈希链） |
| GET | `/api/v1/export/excel` | 同上 Header | 服务端生成 Excel 对账报表，返回 `.xlsx` 文件流 |
| GET | `/api/v1/config` | 无 | 返回当前财务参数（来自 settings 表） |
| GET | `/api/v1/admin/settings` | 管理端 Header | 读取财务参数（GST / 分成 / 佣金） |
| PUT | `/api/v1/admin/settings` | `{ gstRate, platformShareRatio, merchantShareRatio, commissionRate, commissionApplyGst }` | 修改财务参数（需管理端权限） |
| GET | `/api/v1/admin/products` | 管理端 Header | 商品列表（含库存、状态） |
| POST | `/api/v1/admin/products` | `{ sku, name, category, costPrice, sellPrice, description? }` | 新增商品 |
| PUT | `/api/v1/admin/products/:id` | 同上（可部分更新） | 编辑商品 |
| PATCH | `/api/v1/admin/products/:id/status` | `{ status: active/inactive }` | 上架 / 下架商品 |

### 财务参数配置（管理端「财务设置」页 → settings 表）

`settings` 表为 key-value 结构，管理端登录后可在「财务设置」页修改 GST 税率、平台/商家分成比例、佣金率、佣金附加 GST 开关；`finance.js` 优先读数据库，`config.json` 仅作缺省默认值。原有交易算法（读 `shops` 表店铺级参数）不受影响。

```json
// config.json（仅作默认值）
{
  "gst":   { "rate": 0.09, "priceIncludesGst": true },
  "split": { "platform": 0.7, "merchant": 0.3 },
  "commission": { "rate": 0.03, "applyGst": true },
  "scan":  { "duplicateWindowMs": 5000 }
}
```

### 防重复扫码（5 秒窗口）

- **服务端**：`/api/v1/scan/in`、`/api/v1/scan/out` 按「同店铺 + 同商品 + 同类型 + 同操作人」在 `scan.duplicateWindowMs`（5000ms）窗口内拦截，返回 HTTP 429。
- **客户端**：`public/js/db.js` 的 `isDuplicateScan` 窗口默认 5000ms（与 config.json 一致），断网时本地同样拦截。
- 原有接口的防重逻辑（clientRecordId 判重）保持不变。

## 离线同步说明

1. 断网时，前端把扫码记录写入 IndexedDB `pending_records` 队列；
2. 页面顶部离线条显示「网络已断开」+「待上传 X 条」；
3. 网络恢复时自动补传：监听 `window online` 事件 + 页面加载时立即补传 + 每 5 秒轮询（**不依赖 Background Sync，兼容 iOS Safari**）；
4. 补传走 `POST /api/v1/sync`，按 `clientRecordId` 判重，重复记录不会二次入账；
5. 断网浏览页面时，Service Worker 回退到 `offline.html` 离线提示页，联网后一键返回。

## 安全说明

- **强制 HTTPS**：生产环境（Nginx/负载均衡层）将 HTTP 301 跳转到 HTTPS，禁止明文 HTTP 提供服务；
- **密码存储**：bcrypt 哈希（10 轮盐），数据库不落明文；
- **摄像头权限**：扫码需 HTTPS 或 localhost 环境；
- **认证**：用户名 + 密码换发 JWT（12h 有效期），接口按角色鉴权（merchant / staff / brand / admin）；
- **日志防篡改**：每条审计日志以 SHA-256 哈希链串联（`sha256(店铺|用户|动作|目标|备注|上一哈希)`），校验接口 `GET /api/logs/verify` 可验证链完整性；
- **数据库**：SQLite 文件位于 `data/`（可用环境变量 `DATABASE_PATH` 覆盖路径），定期备份即可；离线数据仅在客户端本地，不落第三方存储。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务监听端口 | `3000` |
| `JWT_SECRET` | JWT 签名密钥（生产环境必须设置） | 内置默认值（仅限本地开发） |
| `DATABASE_PATH` | SQLite 数据库文件路径 | `data/inventory.db` |

复制 `.env.example` 并填入真实值后使用；`.env` 已被 .gitignore 排除，不会提交到仓库。

## 目录结构

```
my-pwa/
├── package.json          # 项目配置与依赖（exceljs、bcryptjs 等）
├── server.js             # 后端服务器（原有全部 API + /api/v1 挂载）
├── routes-v1.js          # API v1 接口模块（登录/扫码/同步/报表/管理端）
├── finance.js            # 财务计算模块（GST/分成/佣金，读 settings 表）
├── config.json           # 财务参数默认值（管理端可覆盖，存 settings 表）
├── database.js           # SQLite 初始化与工具函数（含日志哈希链、settings 种子）
├── .env.example          # 环境变量示例
├── .gitignore            # 仓库排除规则（node_modules/、data.db、备份、日志、.env）
├── data/
│   └── inventory.db      # SQLite 数据库（运行后自动生成）
├── docs/
│   ├── INIT.md           # 初始账号（4 家商铺 + 管理端 + 品牌方）
│   ├── 项目现状.md        # 功能完成度盘点（已完成/未完成/规划中）
│   └── CHANGELOG.md      # 版本变更记录（v0.1.0 / v0.1.1 / v0.2.0）
├── public/               # 前端（PWA）
│   ├── index.html        # 合作商家端主页面
│   ├── admin.html        # 品牌方/管理端（含财务设置、商品管理）
│   ├── register.html     # 管理端入口跳转页
│   ├── offline.html      # 离线提示页
│   ├── manifest.json     # PWA 清单（StockVerify SG）
│   ├── sw.js             # Service Worker（应用外壳缓存）
│   ├── css/style.css     # 样式
│   ├── img/stockverify-logo.png  # 品牌字标
│   ├── js/               # app/admin/i18n/db/finance/scanner/sync/export
│   └── icons/            # 192/512 PWA 图标
└── README.md             # 本文档
```

## 版本

当前版本 **v0.2.0**，变更记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
