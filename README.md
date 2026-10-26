# edgeone-webdav

在 **腾讯云 EdgeOne Pages / Makers** 上运行的 WebDAV 服务端，用 **EdgeOne Blob 存储**（`@edgeone/pages-blob`）做后端。

零第三方 WebDAV 库、零数据库，纯 Node.js 云函数，部署后即可用 Finder / Windows 资源管理器 / rclone / Cyberduck 挂载。

```
客户端 ──PROPFIND/PUT/MOVE/LOCK──> EdgeOne 云函数 ──KV 语义──> Blob 命名空间
                                        │
                                        └─ 把扁平的 key-value 映射成目录树
```

---

## 1. 特性

| 能力 | 说明 |
| --- | --- |
| 方法 | `OPTIONS` `GET` `HEAD` `PUT` `DELETE` `PROPFIND` `PROPPATCH` `MKCOL` `COPY` `MOVE` `LOCK` `UNLOCK` |
| 目录树 | 在扁平 KV 上实现，支持空目录、多级嵌套、中文/空格/emoji 文件名 |
| 元信息 | 每个对象维护 `size / mtime / ctime / contentType / etag`，PROPFIND 返回完整属性 |
| 锁 | `LOCK/UNLOCK` 返回合法 `opaquelocktoken`（宽容模式，不校验 `If:` 头，兼容 Windows/macOS 的写入流程） |
| 认证 | HTTP Basic Auth，密码比较使用常量时间比较 |
| 一致性 | 默认**强一致读**（写后立刻可见） |
| 浏览器访问 | `GET` 目录返回简易 HTML 列表页，方便直接看内容 |
| Range | 支持单区间 `Range` 请求（≤ 8 MB）与 `If-None-Match` / 304 |
| 依赖 | 只有 `@edgeone/pages-blob` 一个包 |

---

## 2. 存储模型

`@edgeone/pages-blob` 是扁平 KV（key 最长 600 字节），没有真正的目录。这里用三个前缀把树建起来：

| Blob key | 内容 | 例子 |
| --- | --- | --- |
| `f<path>` | 文件二进制 | `/docs/a.txt` → `f/docs/a.txt` |
| `m<path>` | 元信息 JSON | `/docs/a.txt` → `m/docs/a.txt` |
| `l<path>` | 锁信息 | `/docs/a.txt` → `l/docs/a.txt` |

关键点：**目录的元信息与文件同键不同值**（WebDAV 里同名文件与目录不可能共存），元信息里带 `isDir` 标记。
这样列目录只需一次 `list({ prefix: "m/docs/", directories: true })`：

- `blobs` → 该目录下所有直接成员（含文件与子目录，类型看元信息里的 `isDir`）
- `directories` → 兜底：有更深层级但缺元信息的项（异常中断/历史数据）

根目录元信息固定存在 `m` 这个 key 上（`m/` 前缀不会匹配到它）。

---

## 3. 平台限制（务必先看）

这些是 EdgeOne 云函数 / Blob 的硬限制，不是本项目的取舍：

| 项目 | 限制 | 影响 |
| --- | --- | --- |
| 云函数请求体 | **6 MB** | **单个文件上传上限 6 MB**（超过时平台直接拒绝，或本服务返回 `413`） |
| 云函数响应体 | **6 MB** | 单个文件下载上限约 6 MB |
| 单次执行时长 | 默认 30 s（本仓库 `edgeone.json` 调到 60 s） | 超大目录的 COPY/MOVE/递归 DELETE 可能超时 |
| Blob 单值 | 25 MB | 用不到（6 MB 更早触发） |
| Blob 容量 | 免费版 1 GB / 账号 | 总容量 |
| Blob key | ≤ 600 字节 | 深层路径有 `414` 保护 |

**结论**：这套方案适合笔记库（Obsidian/Markdown）、配置文件、代码片段、图片、小文档同步；不适合传视频、镜像、备份包这类大文件。

想要大文件，扩展点在 `handlePut`：当 `Content-Length > maxUpload` 时用 `store.createUploadUrl(key)` 拿预签名 PUT URL，返回 `307 Temporary Redirect`（rclone / curl 这类会重发请求体的客户端可用），文件字节不经过函数。默认没有开启，因为多数 WebDAV 客户端不会跟随 307 重发 PUT。

---

## 4. 部署

### 方式一：Git 导入（推荐）

1. 把本目录推到 GitHub / Gitee 仓库；
2. 打开 [EdgeOne Makers 控制台](https://console.edgeone.ai/makers)（国内站：`console.cloud.tencent.com/edgeone/makers`）；
3. **新建项目 → 导入 Git 仓库**，构建设置留空即可（纯函数项目，`edgeone.json` 里已声明 `installCommand: npm install`）；
4. **项目设置 → 环境变量**，至少添加：
   ```
   DAV_USER = 你的用户名
   DAV_PASS = 一个足够长的随机密码
   ```
5. 部署完成后访问 `https://<项目域名>/dav`，出现登录框 + 目录页即成功。

> Blob 命名空间会在第一次读写时自动创建，无需在控制台手动开通。

### 方式二：EdgeOne CLI

```bash
npm install -g edgeone
edgeone login
edgeone makers dev      # 本地调试（用你的账号环境）
edgeone makers deploy   # 部署
```

### 目录结构

```
.
├── edgeone.json                     # 部署配置（Node 版本、函数超时、/dav/* no-store）
├── package.json
├── cloud-functions/
│   └── dav/
│       ├── index.js                 # 路由 /dav 与 /dav/
│       ├── [[default]].js           # 路由 /dav/**（多级路径）
│       └── _lib/
│           ├── entry.js             # 环境变量 → config，缓存 handler
│           ├── dav.js               # 核心：路径规范化 + 全部 WebDAV 方法
│           ├── store.js             # pages-blob 适配（生产）
│           ├── memory-store.js      # 内存实现（本地测试用）
│           ├── paths.js             # 路径工具
│           └── xml.js               # XML 生成 / 解析
└── test/dav.test.mjs                # 20 个用例，零外部依赖
```

`cloud-functions/**` 里只有导出了 `onRequest` 的文件才会注册成路由，`_lib/` 下的模块不会被暴露。

---

## 5. 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DAV_USER` | ✅ | — | Basic Auth 用户名 |
| `DAV_PASS` | ✅ | — | Basic Auth 密码（建议 20 位以上随机串） |
| `DAV_ALLOW_ANONYMOUS` | | `false` | `true` 时允许匿名（不建议，等于公开存储） |
| `DAV_BASE` | | `/dav` | 挂载路径，需与路由一致 |
| `DAV_STORE` | | `webdav` | Blob 命名空间名，多个站点可共用账号但用不同命名空间 |
| `DAV_REALM` | | `EdgeOne WebDAV` | 401 挑战里显示的域 |
| `DAV_MAX_UPLOAD` | | `6291456` | 单次 PUT 上限（字节） |
| `DAV_MAX_TREE` | | `500` | COPY/MOVE 递归条目上限，超过报 500 |
| `DAV_MAX_DEPTH_ITEMS` | | `500` | `Depth: infinity` 返回条目上限 |
| `DAV_EVENTUAL` | | `false` | `true` 改用最终一致读（更快，但刚写入的文件可能短暂看不到） |

没配 `DAV_USER`/`DAV_PASS` 又没开匿名时，服务返回 `503` 并提示配置——避免误把存储裸奔。

---

## 6. 客户端配置

**Windows 资源管理器**
```
资源管理器 → 此电脑 → 映射网络驱动器
文件夹: https://<项目域名>/dav
```
必须 HTTPS 且证书有效（Windows 的 WebClient 不接受自签证书）。Windows 会先发 `OPTIONS` → `PROPFIND` → `LOCK`，本服务均已覆盖。

**macOS Finder**
```
Finder → 前往 → 连接服务器 (⌘K) → https://<项目域名>/dav
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

**Cyberduck / RaiDrive / Solid Explorer / Documents**：新建 WebDAV 连接，URL 填 `https://<项目域名>/dav`，勾选 Basic 认证即可。

---

## 7. 本地开发与测试

```bash
npm install          # 只为拿到 @edgeone/pages-blob
npm test             # node --test，20 个用例全绿，不需要网络与账号
```

测试用内存 store（`_lib/memory-store.js`）驱动同一份 `createDavHandler`，覆盖：

- 认证（401 / 错误密码 / 常量时间比较）
- `MKCOL` 201/405/409、`PUT` 201/204/413、`GET`/`HEAD`/Range 206 / 416 / 304
- `PROPFIND` `Depth: 0 / 1 / infinity`、`propname`
- `COPY`/`MOVE` 文件与整棵目录树、`Overwrite: F` 412、复制到自身 409、跨挂载点 502
- `DELETE` 递归、`LOCK`/`UNLOCK`/刷新锁、`PROPPATCH` 命名空间回显
- 中文/空格文件名 href 编码、点段折叠、存储 key 前缀隔离

想连真实 Blob 调试：`edgeone makers dev` 会注入当前项目的 Blob 凭证。

---

## 8. 已知限制与取舍

1. **锁是"宽容模式"**：`LOCK` 会返回合法的 `opaquelocktoken` 并持久化，但写入时不校验 `If:` 头。原因：Windows/macOS 的加锁序列五花八门，严格校验反而会让资源管理器报"无法访问"。多客户端同时编辑同一文件时不做互斥。
2. **`MOVE` = 复制 + 删除**：Blob 没有 rename，整个子树要逐个读元信息再搬（并发 4）。几十个文件没问题，上千个文件会撞上函数超时。
3. **列目录是 N+1 次读**：每个子文件的 `size/mtime` 要单独 `get` 元信息（并发 8）。50 个文件的目录大约几百毫秒，上千个文件会明显变慢。
4. **不支持 `Content-Range` 分块 PUT**：rclone 传大文件时会尝试，本服务直接返回 `400`（反正 6 MB 上限更早挡住）。
5. **`PROPPATCH` 只回 200 不落库**：客户端（Windows 的资源管理器会写 `Win32LastModifiedTime`）能拿到成功响应，但自定义死属性不会持久化。命名空间会正确回显。
6. **目录 `GET` 只是便利页**：不是前端应用，没有上传/删除按钮。

---

## 9. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 一直弹登录框 | 密码错了，或客户端在发 `Expect: 100-continue`；先用 curl 验证：`curl -u user:pass -X PROPFIND -H 'Depth: 1' https://域名/dav/` |
| 所有请求 503 | 忘了配 `DAV_USER` / `DAV_PASS` |
| 上传返回 413 | 文件超过 6 MB（云函数请求体上限），无法绕过 |
| 目录里刚传的文件看不到 | 一致性被设成最终一致了，确认 `DAV_EVENTUAL` 未开启 |
| `PROPFIND` 返回 405 | 请求被中间设备拦了（部分企业代理会 disallow 非标准方法），换网络试 |
| 部署后 404 | 确认 `cloud-functions/dav/[[default]].js` 已提交到仓库（平台检出即扫描该文件决定是否启用函数） |
| 中文文件名乱码 | 客户端没做 UTF-8 href 编码，本服务输出的是 `encodeURIComponent` 形式，属客户端问题 |

验证方法（无需客户端）：

```bash
BASE=https://<项目域名>/dav
curl -sS -u user:pass -X OPTIONS $BASE/ -i | head -20
curl -sS -u user:pass -X MKCOL   $BASE/demo -o /dev/null -w '%{http_code}\n'
curl -sS -u user:pass -T ./a.txt $BASE/demo/a.txt -o /dev/null -w '%{http_code}\n'
curl -sS -u user:pass -X PROPFIND -H 'Depth: 1' $BASE/demo
```

---

## 10. 安全建议

- `DAV_PASS` 用随机长串，不要复用其它站点密码；
- 生产环境绑自定义域名并开启 HTTPS（Basic Auth 明文只在 TLS 里才安全）；
- 需要多人分权限时，把 `DAV_STORE` 按人拆成不同命名空间，各部署一个项目；
- 不要开 `DAV_ALLOW_ANONYMOUS`，EdgeOne 分配的域名是公网可达的。

---

## 附：挂到根路径

想让 `https://域名/` 直接就是 WebDAV 根：

1. 把 `cloud-functions/dav/` 改成 `cloud-functions/[[default]].js`（放在 `cloud-functions` 根下，捕获所有路径）；
2. 设 `DAV_BASE=/`；
3. 此时站点不再有静态资源，所有请求都会进函数。

注意根 catch-all 会吞掉一切路径，若以后要加前端页面，请保留 `/dav` 前缀的方案。
