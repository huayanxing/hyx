# 自建云同步后端（Cloudflare Pages + KV）

工作台本身是**单文件静态网页**，数据默认只存在打开它的那台电脑的浏览器里。
这份后端提供一层云端中转，让手机、家里电脑、办公室电脑看到同一份数据。

- 单文件、零依赖，只用 Cloudflare 自带的 KV 存储
- 免费额度足够个人使用（KV 免费档：10 万次读/天、1000 次写/天、1 GB 存储）
- 数据靠一口令保护，口令只存在于浏览器和后端加密变量里，**不在网页源码中**
- 部署后**一个网址同时提供网页和同步接口**，同源、无跨域问题

---

## 0. 先看清楚：为什么不要用 `workers.dev`

Cloudflare Worker 的默认域名 `*.workers.dev` 在中国大陆**被 DNS 污染**，浏览器直连必然失败
（工作台会提示「连不上后端」）。实测证据：

| 域名 | 本机系统解析 | 真实解析（加密 DNS） | 直连结果 |
| --- | --- | --- | --- |
| `workers.dev` | `66.220.148.145` ← **Facebook 的 IP** | `104.18.12.15`（Cloudflare） | 连接超时 ❌ |
| `pages.dev` | `104.18.20.135` ✅ 正常 | `104.18.20.135` | 连接正常 ✅ |

所以：**后端代码不变，换个域名外壳即可** —— 把同一套代码放进 Pages 项目，地址就从
`https://xxx.workers.dev` 变成 `https://xxx.pages.dev`，国内可直连，而且网页和接口同一个域名。

| 文件 | 用途 |
| --- | --- |
| `../_worker.js` | **Pages 版后端（推荐用这个）**，放在仓库根目录 |
| `worker.js` | Worker 版后端，逻辑完全相同，多了自定义域名时才需要 |

两者的接口、口令、KV 结构**完全一致**，可以随时互换，数据互通。

---

## 一、路线 A：部署到 Cloudflare Pages（推荐，国内可直连）

前提：仓库 `huayanxing/hyx` 已经和你的 Cloudflare Pages 项目做了 Git 连接（之前那次
`npm run build` 失败的构建就是它）。以下步骤都在那个 Pages 项目里做。

### 第 1 步：修正构建配置（原来失败的原因）

Pages 项目 → **Settings** → **Builds & deployments** → **Configure Production deployments**（有的版本叫 Edit configuration）：

| 字段 | 原来（错的） | 改成 |
| --- | --- | --- |
| Framework preset | 某个框架 | **None** |
| Build command | `npm run build` | **清空**（界面不让留空就填 `exit 0`） |
| Build output directory | `dist` / `public` 之类 | **`/`**（不接受就填 `.`） |
| Root directory | 空 | 空（保持） |

保存。**先改这里再去触发部署**，否则会继续跑 `npm run build` 失败。

### 第 2 步：建 KV 命名空间（若已有可跳过）

<https://dash.cloudflare.com> → **Storage & Databases** → **KV** → **Create instance**

名字随便填（比如 `wb-sync-kv`）。**已经在 Worker 里建过 KV 的话直接复用那一个，不用新建。**

### 第 3 步：给 Pages 项目绑 KV

Pages 项目 → **Settings** → **Functions** → **KV namespace bindings**（有的版本在 **Bindings** 下）
→ **Add** → 环境选 **Production**（预览环境 Preview 建议也加一份）：

| 字段 | 填什么 |
| --- | --- |
| Variable name | `WB` （必须是这个，区分大小写） |
| KV namespace | 第 2 步那个 |

### 第 4 步：设同步口令

同一个 Settings 页面 → **Variables and Secrets** → **Add** → 类型选 **Secret**（加密）
→ 环境选 **Production**：

| 字段 | 填什么 |
| --- | --- |
| Variable name | `WB_KEY` |
| Value | 自己定一个口令，**越乱越好**，比如 16 位以上的随机串 |

> 用**和之前 Worker 里一样的口令**最省事 —— 这样各设备不用改配置。
> 也必须是 **Secret** 而不是 Text，否则口令会以明文显示在控制台里。

### 第 5 步：确认代码在仓库里

仓库根目录应当同时有：

```
index.html      ← 工作台网页本体
_worker.js      ← 同步后端（就是本目录 worker.js 的 Pages 版本）
```

`_worker.js` 必须在**输出目录的根**（也就是仓库根），这是 Cloudflare 的硬性要求。
仓库里已有 `/functions` 目录的话要删掉 —— 两者只能留一个。

### 第 6 步：重新部署

Pages 项目 → **Deployments** → 找到最新那次失败的部署 → 点 **Retry deployment**
（或者往仓库推一次新提交，会自动触发）。

必须重新部署：**改完绑定和变量，不重新部署是不生效的。** 这是最常见的坑。

### 第 7 步：拿到地址并自检

部署成功后地址形如：

```
https://<项目名>.pages.dev
```

`<项目名>` 就是你那个 Pages 项目的名字（在 Workers & Pages 列表里能看到）。

**自检方法**：用浏览器直接打开

```
https://<项目名>.pages.dev/api/ping
```

- 看到 `{"ok":false,"error":"method-not-allowed"}` → ✅ 后端通了（这是 GET 请求，本来就该被拒）
- 看到 `kv-not-bound` → 回第 3 步，变量名要正好是 `WB`，然后**重新部署**
- 看到 `key-not-set` → 回第 4 步，变量名要正好是 `WB_KEY`，然后**重新部署**
- 页面打不开 / 一直转圈 → 第 1 步的构建配置没改对

顺带，`https://<项目名>.pages.dev/` 直接打开就是工作台网页，手机浏览器也能用。

### 第 8 步：在工作台里填上

打开工作台（推荐直接用 `https://<项目名>.pages.dev`，这样每台设备都同一个入口）：

**设置** → **☁️ 云同步（多设备）**：

1. 「同步服务地址」填 `https://<项目名>.pages.dev`（**不要带 `/api`**，也不要带结尾斜杠）
2. 「同步口令」填第 4 步的值
3. 点 **测试连接** —— 应显示「连接成功 · 云端已有 N 个分片」
4. 点 **保存并连接** —— 若本机已有真实数据，会询问是否上传到云端，选「确定」

另一台设备打开同一个网址，把地址和口令填成一样的，数据就会自动下来。

---

## 二、路线 B：继续用 Worker + 自定义域名

如果你有**自己的域名**并已托管在 Cloudflare（Worker 的免费自定义域名只有这一条路）：

1. 按上一版流程把 `worker.js` 部署成 Worker（见本文件历史版本或 `wrangler.toml`）
2. Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**，填一个子域名，例如 `sync.你的域名.com`
3. 工作台里地址改填 `https://sync.你的域名.com`

自定义域名不受 `workers.dev` 污染影响，国内可直连。

---

## 三、路线 C：命令行部署（可选）

Worker 版：

```bash
npx wrangler kv namespace create WB        # 记下输出的 id，填进 wrangler.toml
npx wrangler secret put WB_KEY             # 交互式粘贴口令
npx wrangler deploy
```

Pages 版（同样需要先修正上面第 1 步的构建设置）：

```bash
npx wrangler pages deploy . --project-name <项目名>
```

---

## 四、接口一览

除图片读取外，所有接口都要求请求头 `x-wb-key` 等于后端设置的 `WB_KEY`，否则返回 401。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ping` | 自检。返回分片数与图片数 |
| POST | `/api/pull` | 拉取。请求体 `{"known":{"分片键":时间戳}}`，只回传比已知更新的分片正文 |
| POST | `/api/push` | 推送。请求体 `{"items":[{"key","body","ts","dev"}]}` |
| POST | `/api/wipe` | 清空本命名空间的全部数据 |
| POST | `/api/img` | 上传图片。请求体 `{"data":"<base64>","contentType":"image/png"}`，返回可访问地址 |
| GET | `/api/img/:id` | 读取图片（**不校验口令**，靠不可猜的 40 位 id 做凭据，方便 `<img src>` 直接用） |

其余所有路径（`/`、`/index.html`、任何静态文件）都原样交给网页本体，后端不插手。

### 冲突处理

每个分片带一个时间戳。推送时若服务端该分片的更新时间**比来件更新**，则拒绝写入并在
`stale` 中返回该分片键；客户端收到 `stale` 会立即回头拉取云端最新版本。
即「谁新听谁的」，不会出现旧数据覆盖新数据。

### 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `WB_KEY` | 同步口令，**必填**。未设置时服务一律拒绝，不会敞开 |
| `WB_NS` | 命名空间前缀，默认 `wb`。同一个后端可给多人各一套互不相通的数据 |

---

## 五、安全说明（请如实理解）

- **同步口令**保护的是业务数据（成绩、名单、沟通记录等）。它不在网页源码里，只存在浏览器本地存储和后端加密变量中；导出的 JSON 备份文件也**不含**口令。
- **图片是个例外**：图片读取接口不校验口令（因为 `<img src>` 无法带请求头），改用 40 位十六进制随机 id 作为访问凭据 —— 也就是「拿到完整链接就能看」。链接本身存在受口令保护的分片数据里，正常不会外泄，但请不要把单张图片的链接直接发到公开场合。
- 后端地址是公开可访问的，**安全性完全取决于口令强度**。请用足够长的随机串，不要用生日、手机号之类。
- 数据放在你**自己的** Cloudflare 账号下，不经过任何第三方服务。

---

## 六、同步失败怎么查

点「设置 → ☁️ 云同步（多设备）」里的**测试连接**，或看同步失败后那张卡片上的提示文字，对照下表：

| 提示 | 含义 | 怎么修 |
| --- | --- | --- |
| **连不上后端** | 域名不通（最常见就是用了 `workers.dev`）或地址写错 | ①地址必须改成 `https://<项目名>.pages.dev`；②浏览器直接打开该地址自检 |
| 口令不对（401） | 网页里填的口令 ≠ 后端的 `WB_KEY` | 逐字符核对，注意别带上首尾空格 |
| 地址不对（404） | 地址里带了 `/api` 或多余路径 | 只填 `https://<项目名>.pages.dev` |
| 后端没绑定 KV | 绑定的变量名不是 `WB`，或加完绑定**没重新部署** | Bindings 里变量名必须正好是 `WB`；改完必须**重新部署** |
| 后端没设口令 | 变量名拼错，或加到了 Preview 环境而不是 Production | Variables and Secrets 里确认名字是 `WB_KEY`、环境是 Production |
| 后端内部错误 | 代码抛异常 | Pages 项目 → **Deployments** → 选部署 → **Logs** 看堆栈 |

### 最容易踩的四个坑

1. **还在用 `workers.dev` 地址。** 国内解析被污染，一定会「连不上后端」。必须换成 `pages.dev`。
2. **改完绑定或变量，没有重新部署。** 在当前版本上加 KV 绑定、加环境变量，**不会**自动作用到正在运行的版本；要去 Deployments 点一次 **Retry deployment** 才生效。
3. **每台设备都要单独填一次地址和口令。** 这两项存在各自浏览器的本地存储里，**不随云端数据同步**。新设备打开后如果没填，它就停在「单机模式」，当然看不到云端数据。
4. **变量只加到 Preview 环境。** Pages 的 Production 和 Preview 是两套配置，正式访问用的是 Production，两个都加上最保险。
