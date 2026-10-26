# 图纸尺寸识别（Drawing Detection）

一个演示「视觉大模型读工程图」的双页面应用。核心思路是把读图拆成人类真正的做法：

> **先定位，再识别。** 第一步只找"标注印在哪"，由人确认框的位置；第二步才读"每个框里写的是什么"。

这样每一步都看得见、能修改、可解释，也能在出错时判断是"框错了"还是"读错了"。

线上地址：<https://johnnytao.com.cn/cisco-demo/>

---

## 一、两个页面、三个步骤

### 页面 1 · 图纸库 `/cisco-demo`

- 上传图纸（PNG/JPG，单张 ≤ 10 MB，每个会话最多 5 张），与内置测试图纸分开展示。
- 上传的图带「本次会话」标记，可单张删除。
- 每张卡片显示状态：`未检测` / `已定位 N 处` / `已识别 N 条 · M 待复核` / `上次运行失败`。
- 点击卡片进入工作台；有进度的显示「继续 →」。

### 页面 2 · 检测工作台 `/cisco-demo/workspace?run=<id>`

| 步骤 | 做什么 | 产物 |
|---|---|---|
| ① 标注定位 | 只输出**框**：位置 + 编号。不返回文字、数字、类型，也不上色 | 灰框图层，可删除 / 手动补框 |
| ② 内容识别 | 按**你确认过的框**逐条读取，边读边更新 | 框逐条上色，表格逐行填充 |
| ③ 复核导出 | 人看表格、改框、重跑 | 标注图 PNG + 明细 CSV |

工作台要点：

- **框是网页图层，不是烤进图片的**：悬停、选中、删除、补框都是即时的；框与表格行双向高亮。
- **可改框**：点空白处拖出一个框即可新增；选中框后按 `Delete` 或点框角上的 × 删除。
- **进度可见**：识别阶段显示 `正在逐条读取 7/12` 和进度条，不是转圈等待。
- **单条失败不拖垮整轮**：读不到文字的框会标成「读取失败 · 待复核」，其余照常出结果。
- **刷新不丢进度**：运行记录落盘，刷新后按 URL 里的 `run` 恢复；关掉标签页才清空会话。

---

## 二、本地运行

```bash
npm install

python -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv/Scripts/pip

cp .env.example .env                            # 填入 LLM 密钥
npm run dev                                     # http://localhost:3000/cisco-demo
```

> 应用挂在 `/cisco-demo` 前缀下（`next.config.ts` 的 `basePath`）。`.env` 里的
> `NEXT_PUBLIC_BASE_PATH` 必须与之一致，且要在 **构建时** 生效，否则前端请求会打到
> 未加前缀的 `/api/*` 而 404。

---

## 三、目录结构

```
src/
├── app/
│   ├── page.tsx                    图纸库（上传、分组、状态）
│   ├── workspace/page.tsx          工作台（三步流程）
│   └── api/
│       ├── images/route.ts         图纸列表 + 每张图的运行状态
│       ├── image/route.ts          原图
│       ├── upload/route.ts         上传 / 删除（POST / DELETE）
│       ├── runs/route.ts           创建运行 → 排队执行「标注定位」
│       ├── runs/[id]/route.ts      GET 运行状态 / PATCH 保存用户改过的框
│       ├── runs/[id]/read/route.ts 排队执行「内容识别」
│       ├── runs/[id]/image/route.ts 标注图（导出用）
│       └── verify-pin/route.ts     PIN 校验，成功后下发 HttpOnly 凭证
├── components/
│   ├── BoxCanvas.tsx               画布 + 交互框图层（缩放、拖拽新增、删除）
│   ├── DimensionTable.tsx          结果表格（悬停/选中联动）
│   ├── StepBar.tsx                 三步状态条
│   ├── PinGate.tsx                 全站 PIN 门禁
│   └── Header.tsx
└── lib/
    ├── runStore.ts                 运行记录（内存 + output/runs/<id>/run.json）
    ├── runQueue.ts                 串行队列（同时 1 个执行，最多 2 个等待）
    ├── detectJob.ts                调用 Python 两阶段引擎，回填进度
    ├── uploadStore.ts              上传登记（会话级，24h TTL）
    ├── quota.ts                    每会话检测次数上限
    ├── pinAuth.ts / pinGuard.ts    PIN 凭证与接口保护
    └── session.ts                  会话标识（sessionStorage）

python/drawing_detection/
├── stage_cli.py                    两阶段 CLI：locate / read
├── prompts/locate.py               定位提示词（按配置拼装）
├── prompts/extract.py              原一体化抽取提示词 + 单框读取提示词
├── locator.py                      CV 文本连通域，把模型框吸附到真实文字
├── parser.py                       文本解析（公差/单位/类型/数量）
├── classifier.py                   特征归类（孔径/板厚/折弯等）
├── detector.py                     通道探测、调用、失败切换
└── visualizer.py                   导出标注图

output/runs/<runId>/                run.json / locate.json / read.json
                                    progress.json / boxes.json / annotated.png
```

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/images?session=` | 测试图纸 + 本会话上传 + 各自的运行摘要 |
| GET | `/api/image?name=` | 原图 |
| POST | `/api/upload` | 上传（`multipart/form-data`：`file`、`session`） |
| DELETE | `/api/upload?name=&session=` | 删除上传（连带删除其运行记录） |
| POST | `/api/runs` | `{session, filename, config, channel, runId?}` → 创建/重跑并排队定位 |
| GET | `/api/runs/:id` | 运行状态（含队列位置、进度、已读出的部分结果） |
| PATCH | `/api/runs/:id` | `{boxes:[{x,y,w,h}]}` → 保存用户确认后的框 |
| POST | `/api/runs/:id/read` | 排队执行内容识别 |
| GET | `/api/runs/:id/image?variant=annotated&download=1` | 标注图导出 |
| GET/POST | `/api/verify-pin` | `GET` 返回是否需要 PIN；`POST {pin}` 校验并下发凭证 |

`config` 字段（每一项都会真实改变发给模型的请求）：

```jsonc
{
  "scope": "dimensions" | "all_text",          // 仅尺寸标注 / 含技术要求
  "granularity": "annotation" | "value",       // 整条标注 / 单个数值
  "density": "conservative" | "standard" | "aggressive",
  "excludeTitleBlock": true
}
```

---

## 五、配置（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_BASE_PATH` | `/cisco-demo` | 必须与 `next.config.ts` 的 `basePath` 一致 |
| `LLM_1_API_KEY` / `LLM_1_BASE_URL` / `LLM_1_MODEL` | — | 通道 1：本地 STG 服务器 |
| `LLM_2_API_KEY` / `LLM_2_BASE_URL` / `LLM_2_MODEL` | — | 通道 2：阿里云 DashScope（界面默认） |
| `LLM_FAILOVER` | `0` | `1` 时超时自动切另一通道 |
| `LLM_{1,2}_EXTRA_BODY` | 关闭 thinking | 每通道额外请求体 |
| `APP_PIN` | — | 页面 PIN，服务端校验；留空则不启用 |
| `MAX_RUNS_PER_SESSION` | `20` | 每会话新建检测次数上限 |
| `RUN_TTL_MS` | 24h | 运行记录保留时长 |
| `UPLOAD_TTL_MS` | 24h | 上传文件保留时长 |

---

## 六、部署（johnnytao.com.cn/cisco-demo）

### 1. 构建

```bash
cd /home/dev/drawing-detection-web
npm ci
npm run build          # basePath=/cisco-demo 在此固化
```

### 2. 常驻服务

`/etc/systemd/system/cisco-demo.service`：

```ini
[Unit]
Description=cisco-demo (drawing detection · locate + read)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/home/dev/drawing-detection-web
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=768
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=5

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
# 运行期唯一需要写入的目录：上传、运行产物、Next 缓存
ReadWritePaths=/home/dev/drawing-detection-web/uploads
ReadWritePaths=/home/dev/drawing-detection-web/output
ReadWritePaths=/home/dev/drawing-detection-web/.next/cache
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

```bash
chown -R www-data:www-data uploads output .next/cache
systemctl daemon-reload
systemctl enable --now cisco-demo
```

### 3. Caddy（追加到 `johnnytao.com.cn` 站点块，放在末尾 `respond 404` 之前）

```caddy
# 图纸尺寸识别演示（Next.js 自带 /cisco-demo 前缀）
handle /cisco-demo* {
    reverse_proxy 127.0.0.1:3000
}
```

> 两个坑：① 必须用 `handle`，**不能**用 `handle_path` —— 应用自身已带 `/cisco-demo`
> 前缀，剥掉会 404；② **不要**在 Caddy 里给裸路径补斜杠 —— Next 会把
> `/cisco-demo/` 308 回 `/cisco-demo`，两边会形成无限重定向。

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 4. 验收清单

- [ ] `https://johnnytao.com.cn/cisco-demo/` 正常打开，静态资源无 404
- [ ] 输入 PIN 后可上传、定位、删框/补框、识别、导出
- [ ] 刷新工作台，进度仍在；PIN 重新要求输入
- [ ] 同一浏览器第二个标签页操作，提示排队而不是报错
- [ ] 回归：`/books`、`/history`、`/files`、`/design-md` 仍正常

### 5. 回滚

```bash
systemctl disable --now cisco-demo
cp /etc/caddy/Caddyfile.bak-<时间戳> /etc/caddy/Caddyfile
systemctl reload caddy
```

---

## 七、运行机制与保护

- **两步各一次模型调用**：定位是整图一次（输出只要坐标，快）；识别是每个框一次小图调用（可并发），因此总耗时与原来的一体化抽取相当，但过程可见。
- **人工确认的框就是最终范围**：识别阶段不再做"事后位置校正"，少一类奇怪错误，也更快。
- **串行队列**：同时只跑 1 个任务，最多 2 个等待，第 3 个提示稍后再试。避免多标签页把网关配额打爆。
- **PIN 双层保护**：界面弹窗 + 服务端 HttpOnly 凭证。计费类接口（创建运行、识别、上传、改框）都要求凭证，防止绕过前端直接调用。
- **每会话配额**：默认 20 次新建检测，刷新页面重置。
- **自动清理**：运行记录与上传文件 24 小时过期；上传被删除或过期后，其运行记录一并清理。

---

## 八、已知限制

- 定位是"模型给框 + CV 吸附文字"，遇到极小字号、严重旋转或低分辨率图纸可能漏框或框偏 —— 这正是第二步允许人工增删的原因。
- 读取按框裁剪，框太紧时可能截断字符；建议框略微包住文字。
- 单次运行上限：定位 60 个框；每会话 20 次检测。
- 类型判断依赖框内符号（Φ/R/°），框里没有符号的纯数字会归为 linear。
