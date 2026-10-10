# StockVerify — 系统架构与离线同步

> 当前版本 v0.3.4 · 多国零售分销库存系统（PWA）
> 所有税务 / 货币 / 分成参数均由管理端配置，支持多国、多税制、多货币。

## 一、总体架构

```mermaid
flowchart TD
    subgraph Client["客户端层"]
        PWA["PWA 前端<br/>app.js · scanner.js<br/>扫码入库/出库 · IndexedDB 离线队列"]
        ADM["管理端<br/>admin.html · admin.js<br/>商品 / 授权 / 系统设置"]
        SW["Service Worker<br/>APP_SHELL 缓存 · offline.html 回退"]
    end

    subgraph Access["接入层"]
        Sec["security.js<br/>CORS 白名单 · HTTPS 强制 · 登录限流"]
    end

    subgraph API["API 层"]
        V1["/api/v1/*<br/>JWT + RBAC<br/>shopId 强制隔离"]
        Legacy["/api/*<br/>74 legacy 路由"]
    end

    subgraph Logic["业务逻辑层"]
        Fin["finance.js<br/>含税 / 不含税双口径<br/>分成 · 佣金 · 佣金附加税"]
        Auth["授权链路<br/>总代 → 代理 → 商家<br/>撤销级联删除下游"]
    end

    subgraph Data["数据层"]
        DB[("SQLite 13 表<br/>商品 / 交易 / 设置 / 授权 / 日志")]
        Audit["哈希链审计<br/>appendAuditLog<br/>verifyAuditChain"]
        XLS["Excel 导出<br/>ExcelJS 对账报表"]
    end

    PWA --> SW
    PWA --> Sec
    ADM --> Sec
    SW -.离线补传.-> V1
    Sec --> V1
    Sec --> Legacy
    V1 --> Fin
    V1 --> Auth
    Legacy --> Fin
    Fin --> DB
    Auth --> DB
    V1 --> Audit
    V1 --> XLS
    Audit --> DB
```

**说明**

- 客户端为 PWA：首次访问后可离线打开，扫码入库 / 出库在断网时写入 IndexedDB 待上传队列；管理端支持商品 / 授权链路 / 系统参数配置。
- 接入层统一处理跨域白名单、HTTPS 强制与登录限流（`security.js`，legacy 与 v1 独立计数）。
- API 分两层：`/api/v1/*` 为规范化新接口（JWT + RBAC + 按 `shopId` 强制隔离）；`/api/*` 为 74 条 legacy 路由，待逐步迁移。
- 业务逻辑层：财务口径由 `finance.js` 统一计算（含税 / 不含税、分成、佣金、佣金附加税）；商品授权按「总代 → 代理 → 商家」分层，撤销时递归级联删除下游。
- 数据层：SQLite 13 表支撑商品 / 交易 / 设置 / 授权 / 日志；操作日志以 SHA-256 哈希链存储，`/api/logs/verify` 可校验完整性；对账报表经 ExcelJS 导出。

## 二、离线同步流程

```mermaid
flowchart TD
    A["断网扫码入库 / 出库"] --> B["写入 IndexedDB 待上传队列<br/>（记录含条码、数量、时间、防重 ID）"]
    B --> C{"网络恢复？<br/>window online 事件<br/>或页面加载时补传"}
    C -->|是| D["POST /api/v1/sync<br/>批量补传记录"]
    C -->|否| B
    D --> E{"服务器逐条写库成功？"}
    E -->|成功| F["删除本地已同步记录<br/>更新「待上传 X 条」计数"]
    E -->|失败| G["保留本地记录<br/>下次联网重试"]
    G --> C
```

**说明**

- 不依赖 iOS Safari 不支持的 Background Sync：同时监听 `window online` 事件，并在页面加载时主动补传。
- 每条记录带 `clientRecordId`，服务端按此防重，重复补传自动跳过。
- 页面顶栏实时显示「待上传 X 条」，联网后自动清空。
