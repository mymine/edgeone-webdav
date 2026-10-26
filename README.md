# edgeone-webdav

在 **腾讯云 EdgeOne Pages / Makers** 上运行的 WebDAV 服务端，用 **EdgeOne Blob 存储**做后端。

**零 npm 依赖、零构建步骤**（pages-blob SDK 以源码形式内置在 `_vendor/`），部署后即可用 Finder / Windows 资源管理器 / rclone / Cyberduck 挂载。

```
客户端 ──PROPFIND/PUT/MOVE/LOCK──> EdgeOne 云函数 ──KV 语义──> Blob 命名空间
                                        │
                                        └─ 把扁平的 key-value 映射成目录树
```

---

## ⚠️ 必读：访问地址与 401 / 404

部署完先分清「平台的访问限制」和「本服务的报错」，两者长得完全不一样：

| 你看到的 | 实际含义 | 是不是本项目的问题 |
| --- | --- | --- |
| `404 : NOT_FOUND (Code: NOT_FOUND)` + **The site does not exist** | EdgeOne 平台：这个域名上没有站点 | ❌ 域名/部署问题 |
| `401 : UNAUTHORIZED` + `X-EOP-MSG: eo_time missing` | EdgeOne 平台：访问限制，缺签名参数 | ❌ 平台合规策略 |
| 纯文本 `Not Found`（`text/plain`） | 本服务：路径不存在 | ✅ 才是这里的事 |
| `503` + 提示配置 `DAV_USER` | 本服务：没配账号 | ✅ |

**为什么项目域名会 401**（官方 domain-overview 文档）：

- 加速区域为「中国大陆可用区」或「全球可用区（含中国大陆）」时，项目域名 / 部署域名**只能通过控制台「预览」按钮生成的链接访问**，该链接 **3 小时过期**，过期返回 401；
- 加速区域为「全球可用区（不含中国大陆）」时，海外网络可直接访问，**中国大陆网络访问返回 401**。

**这对 WebDAV 是致命的**：预览链接把 `eo_token` / `eo_time` 放在 query 上，而 WebDAV 客户端只会记住 base URL——
它对子路径发的是 `/dav/notes/a.txt`，**query 参数不会带过去**，第二个请求就 401。
所以：

> **WebDAV 必须走自定义域名（或在「不含中国大陆」区域且访问方在海外）。预览链接只能用来在浏览器里点开看。**

要长期可用：

1. 项目 → **域名管理 → 添加自定义域名**（加速区域含中国大陆时域名需完成 ICP 备案）；
2. 按提示加 CNAME（如 `cname.edgeone.net`）并开启 HTTPS；
3. 之后 WebDAV 地址就是 `https://你的域名/dav`，稳定、免签名。

临时验证（把完整预览链接复制出来，含 `?eo_token=...&eo_time=...`）：

```bash
# 注意：必须带上 query，否则 401
curl -sS "https://<项目>-<hash>.edgeone.cool/ping?eo_token=xxx&eo_time=123" | head -30
curl -sS "https://<项目>-<hash>.edgeone.cool/dav/?eo_token=xxx&eo_time=123" -u user:pass -X PROPFIND -H 'Depth: 1'
```

> 想绕过 401 做临时测试，也可以用 CLI 部署：`edgeone makers deploy` 会直接输出带签名的完整 URL。

---

## 0. 部署完先打开这两个地址

| 地址 | 是什么 | 说明 |
| --- | --- | --- |
| `/` | **静态自检页** | 静态资源能打开 = 站点部署成功；页面里会显示 `/ping` 的探测结果 |
| `/ping` | **函数自检接口** | 返回 JSON（Node 版本、挂载地址、`DAV_*` 变量名、认证状态）。能返回 JSON = 云函数已生效 |
| `/dav` | **WebDAV 挂载点** | 用客户端连接；浏览器直接打开会看到目录列表 |

这三个地址的状态分开看，就能定位 404 卡在哪一层：

- `/` 和 `/ping` 都 404 → 站点/构建没生效（见第 11 节）
- `/` 能开、`/ping` 404 → 云函数没被识别（`cloud-functions/` 不在仓库根，或入口文件没提交）
- 都正常、只有 `/dav` 不通 → 认证或客户端配置问题

---

## 1. 特性

| 能力 | 说明 |
| --- | --- |
| 方法 | `OPTIONS` `GET` `HEAD` `PUT` `DELETE` `PROPFIND` `PROPPATCH` `MKCOL` `COPY` `MOVE` `LOCK` `UNLOCK` |
| 目录树 | 在扁平 KV 上实现，支持空目录、多级嵌套、中文/空格/emoji 文件名 |
| 元信息 | 每个对象维护 `size / mtime / ctime / contentType / etag`，PROPFIND 返回完整属性 |
| 锁 | `LOCK/UNLOCK` 返回合法 `opaquelocktoken`（宽容模式，兼容 Windows/macOS 写入流程） |
| 认证 | HTTP Basic Auth，密码使用常量时间比较 |
| 一致性 | 默认**强一致读**（写后立刻可见） |
| 浏览器访问 | `GET` 目录返回可点击的 HTML 列表页 |
| Range | 支持单区间 `Range`（≤ 8 MB）与 `If-None-Match` / 304 |

---

## 2. 存储模型

`@edgeone/pages-blob` 是扁平 KV（key ≤ 600 字节），没有真正的目录。三个前缀把树建起来：

| Blob key | 内容 | 例子 |
| --- | --- | --- |
| `f<path>` | 文件二进制 | `/docs/a.txt` → `f/docs/a.txt` |
| `m<path>` | 元信息 JSON | `/docs/a.txt` → `m/docs/a.txt` |
| `l<path>` | 锁信息 | `/docs/a.txt` → `l/docs/a.txt` |

关键点：**目录的元信息与文件同键不同值**（WebDAV 里同名文件与目录不可能共存），元信息里带 `isDir`。
所以列目录只要一次 `list({ prefix: "m/docs/", directories: true })`：

- `blobs` → 该目录所有直接成员（含文件与子目录，类型看元信息里的 `isDir`）
- `directories` → 兜底：有更深层级但缺元信息的项

根目录元信息固定存在 `m` 这个 key 上（`m/` 前缀不会匹配到它）。

---

## 3. 平台限制（务必先看）

| 项目 | 限制 | 影响 |
| --- | --- | --- |
| 云函数请求体 | **6 MB** | **单个文件上传上限 6 MB**（超过由平台拒绝，或本服务返回 `413`） |
| 云函数响应体 | **6 MB** | 单个文件下载上限约 6 MB |
| 单次执行时长 | 默认 30 s（`edgeone.json` 已调到 60 s） | 超大目录的 COPY/MOVE/递归 DELETE 可能超时 |
| Blob 单值 | 25 MB | 用不到（6 MB 更早触发） |
| Blob 容量 | 免费版 1 GB / 账号 | 总容量 |
| Blob key | ≤ 600 字节 | 深层路径有 `414` 保护 |

**结论**：适合笔记库（Obsidian/Markdown）、配置、代码片段、图片、小文档同步；不适合视频、镜像、备份包。

要大文件，扩展点在 `handlePut`：`Content-Length` 超限时用 `store.createUploadUrl(key)` 拿预签名 PUT URL 返回 `307`，字节不经过函数（rclone/curl 会重发 body，Finder 这类不会）。默认未开启。

---

## 4. 部署

### 方式一：Git 导入（推荐）

1. 把**本目录的内容**推到仓库根（仓库根应为 `cloud-functions/`、`public/`、`edgeone.json` 同级，不要多套一层 `edgeone-webdav/`）；
2. [EdgeOne Makers 控制台](https://console.edgeone.ai/makers) → **新建项目 → 导入 Git 仓库**；
3. 构建设置：装包命令留空或 `npm install`，构建命令留空（项目零依赖，`edgeone.json` 已声明输出目录 `public`）；
4. **项目设置 → 环境变量**，至少添加：
   ```
   DAV_USER = 你的用户名
   DAV_PASS = 一个足够长的随机密码
   ```
5. 部署完成后先访问 `https://<项目域名>/`（自检页）和 `/ping`（JSON），再访问 `/dav`。

> Blob 命名空间会在第一次读写时自动创建，无需在控制台手动开通。

### 方式二：EdgeOne CLI

```bash
npm install -g edgeone
edgeone login
edgeone makers dev      # 本地调试
edgeone makers deploy   # 部署
```

---

## 5. 目录结构

```
.
├── edgeone.json                     # nodeVersion / outputDirectory=public / 函数超时 / no-store 头
├── package.json                     # 无 dependencies（零依赖）
├── public/
│   └── index.html                   # 静态自检页（/）
├── cloud-functions/
│   ├── [[default]].js               # ⚠️ 根级唯一路由文件（见下）
│   └── dav/
│       ├── _vendor/
│       │   └── pages-blob.cjs       # @edgeone/pages-blob@0.0.18 的 dist 单文件（19 KB）
│       └── _lib/
│           ├── entry.js             # 环境变量 → config，缓存 handler
│           ├── dav.js               # 核心：路径规范化 + 全部 WebDAV 方法
│           ├── ping.js              # /ping 自检（命名导出，不注册路由）
│           ├── store.js             # Blob 适配
│           ├── memory-store.js      # 内存实现（本地测试）
│           ├── paths.js             # 路径工具
│           └── xml.js               # XML 生成 / 解析
├── scripts/dev-server.mjs           # 本地 http 调试服务
└── test/                            # 24 个用例，零依赖
```

只有导出了 `onRequest` 的文件才会注册成路由，`_lib/` / `_vendor/` 下的模块不会被暴露。

> **为什么根级只留一个函数文件**（都是实测踩出来的）：
>
> 1. **catch-all 放在子目录不生效**：只放在 `cloud-functions/dav/[[default]].js` 时，构建日志出现
>    `[cli] No server-handler detected, generating routes.json for pure project`，
>    catch-all 不注册，`/dav` 直接拿到平台那句误导人的 `404 : NOT_FOUND The site does not exist`。
> 2. **根级有第二个具名函数会被当成兜底**：同时存在 `ping.js` 和 `[[default]].js` 时，平台把未匹配路径
>    兜底给了 `ping.js`，表现为访问 `/dav` 却返回 `/ping` 的 JSON（注意 `route.path` 显示的是 `/dav`）。
>
> 所以现在 `cloud-functions/` 下**只有一个 `onRequest` 文件** `[[default]].js`，其余全是普通模块：
> `/ping`、`/__diag`、`/dav/**`、`/` 全部在它内部按路径分发。这样平台没有第二个可兜底的对象。

升级 SDK：`npm pack @edgeone/pages-blob`，把 `dist/index.js` 覆盖到 `_vendor/pages-blob.cjs`，跑一遍 `npm test`。

---

## 6. 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DAV_USER` | ✅ | — | Basic Auth 用户名 |
| `DAV_PASS` | ✅ | — | Basic Auth 密码（建议 20 位以上随机串） |
| `DAV_ALLOW_ANONYMOUS` | | `false` | `true` 时允许匿名（等于公开存储，不建议） |
| `DAV_BASE` | | `/dav` | 挂载路径，需与路由一致 |
| `DAV_STORE` | | `webdav` | Blob 命名空间名，可用来隔离多套数据 |
| `DAV_REALM` | | `EdgeOne WebDAV` | 401 挑战里显示的域 |
| `DAV_MAX_UPLOAD` | | `6291456` | 单次 PUT 上限（字节） |
| `DAV_MAX_TREE` | | `500` | COPY/MOVE 递归条目上限 |
| `DAV_MAX_DEPTH_ITEMS` | | `500` | `Depth: infinity` 返回条目上限 |
| `DAV_EVENTUAL` | | `false` | `true` 改用最终一致读（更快，但刚写入可能短暂看不到） |

没配账号又没开匿名时，`/dav` 返回 `503` 并提示配置，避免把存储裸奔在公网。

---

## 7. 客户端配置

**Windows 资源管理器**
```
此电脑 → 映射网络驱动器 → 文件夹: https://<项目域名>/dav
```
必须 HTTPS 且证书有效（WebClient 不接受自签证书）。

**macOS Finder**
```
前往 → 连接服务器 (⌘K) → https://<项目域名>/dav
```

**rclone**
```bash
rclone config create eodav webdav \
  url=https://<项目域名>/dav \
  vendor=other \
  user=你的用户名 \
  pass=$(rclone obscure '你的密码')

rclone lsd eodav:
rclone copy ./notes eodav:notes --progress
```

**Cyberduck / RaiDrive / Solid Explorer / Documents**：新建 WebDAV 连接，URL 填 `https://<项目域名>/dav`，选 Basic 认证。

---

## 8. 本地开发与测试

```bash
npm test                    # node --test，24 个用例，不需要网络与账号
npm run dev                 # 起 http://127.0.0.1:8787/dav（账号 dav/dav，数据在内存）
```

`npm test` 用内存 store 驱动同一份 `createDavHandler`，覆盖：认证、`MKCOL` 201/405/409、`PUT` 201/204/413、`GET`/`HEAD`/Range 206/416/304、`PROPFIND` 三种 Depth、`COPY`/`MOVE` 递归与 412/409/502、`DELETE` 递归、`LOCK`/`UNLOCK`/刷新锁、`PROPPATCH` 命名空间回显、中文 href 编码、点段折叠、key 前缀隔离。

---

## 9. 已知限制与取舍

1. **锁是宽容模式**：返回合法 token 并持久化，但写入不校验 `If:` 头。原因：严格校验会让 Windows/macOS 报「无法访问」。多客户端同时编辑同一文件不做互斥。
2. **`MOVE` = 复制 + 删除**：Blob 没有 rename，整棵子树要逐个搬（并发 4）。几十个文件没问题，上千个会撞超时。
3. **列目录是 N+1 次读**：每个子文件的 `size/mtime` 单独读元信息（并发 8）。50 个文件约几百毫秒。
4. **不支持 `Content-Range` 分块 PUT**：rclone 传大文件会尝试，本服务返回 `400`（6 MB 上限更早挡住）。
5. **`PROPPATCH` 只回 200 不落库**：死属性不持久化，但命名空间会正确回显。
6. **目录 `GET` 只是便利页**：没有上传/删除按钮。

---

## 10. 安全建议

- `DAV_PASS` 用随机长串，不要复用其它站点密码；
- 生产环境绑自定义域名并开 HTTPS（Basic Auth 只在 TLS 内才安全）；
- 多人分权限：按 `DAV_STORE` 拆命名空间，各部署一个项目；
- 不要开 `DAV_ALLOW_ANONYMOUS`。

---

## 11. 排错

### 打开域名看到 `404: NOT_FOUND`

这种响应体不是本服务返回的（本服务的 404 是纯文本 `Not Found`），说明请求没进函数/没有静态产物。按顺序查：

1. **仓库根目录结构**（最常见）：仓库根必须是 `cloud-functions/`、`public/`、`edgeone.json` 同级。
   如果你是解压 zip 后把整个 `edgeone-webdav/` 推上去的，仓库根会多一层，平台扫描不到 `cloud-functions/`，结果就是全站 404。
2. **输出目录**：`edgeone.json` 里 `outputDirectory` 应为 `public`，且 `public/index.html` 已提交。
3. **构建日志**：搜 `No server-handler detected`。出现就说明函数入口没被识别——确认 `cloud-functions/dav/[[default]].js` 与 `cloud-functions/ping.js` 真的在仓库里（部分工具/网页上传会丢带方括号的文件名）。
4. **项目类型**：必须是支持 Cloud Functions（Node.js）的 Makers 项目，不能是「纯静态站点」。
5. **改完要重新部署**：环境变量、文件结构的改动都需要重新触发一次构建。

### 其他现象

| 现象 | 原因 / 处理 |
| --- | --- |
| `/?` 正常、`/ping` 404 | 函数没生效，见上面第 1、3 条 |
| `/ping` 正常、`/dav` 503 | 忘了配 `DAV_USER` / `DAV_PASS` |
| 一直弹登录框 | 密码错，或客户端发 `Expect: 100-continue`；先用 curl 验证 |
| 上传返回 413 | 文件超过 6 MB，无法绕过 |
| 刚传的文件看不到 | 一致性被设成最终一致，确认 `DAV_EVENTUAL` 未开启 |
| `PROPFIND` 返回 405 | 中间设备拦截非标准方法，换网络试 |
| 中文文件名乱码 | 客户端未按 UTF-8 编码 href，属客户端问题 |

命令行验证：

```bash
BASE=https://<项目域名>/dav
curl -sS https://<项目域名>/ping
curl -sS -u user:pass -X OPTIONS $BASE/ -i | head -20
curl -sS -u user:pass -X MKCOL   $BASE/demo -o /dev/null -w '%{http_code}\n'
curl -sS -u user:pass -T ./a.txt $BASE/demo/a.txt -o /dev/null -w '%{http_code}\n'
curl -sS -u user:pass -X PROPFIND -H 'Depth: 1' $BASE/demo
```

---

## 附：挂到根路径

想让 `https://域名/` 直接就是 WebDAV 根：

1. 删掉 `public/index.html`，把 `cloud-functions/dav/` 的内容移到 `cloud-functions/[[default]].js`（放在 `cloud-functions` 根下，捕获所有路径）；
2. 设 `DAV_BASE=/`；
3. `edgeone.json` 去掉 `outputDirectory`。

根 catch-all 会吞掉一切路径，若以后要加前端页面，请保留 `/dav` 前缀方案。
