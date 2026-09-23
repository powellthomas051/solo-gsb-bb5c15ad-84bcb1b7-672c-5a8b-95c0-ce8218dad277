# 🎭 剧场排练 · 多人时序编排 Web 应用

一个用于剧场联排的**多人协作时间线**工具：导演、场记、音控在同一剧目里共同编排
「场次 — 动作 — 音效」，所有编辑实时同步，离线可继续编辑，重连后自动合并并
**确定性地解决并发冲突**，所有客户端最终得到完全一致的顺序。

技术栈：Python 3.11 · FastAPI · SQLite（WAL）· 原生 HTML/CSS/JavaScript（零构建）· WebSocket。

---

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
```

然后浏览器打开：

```
http://localhost:8000
```

- 宿主机端口：**8000**（容器内也是 8000）
- SQLite 数据持久化在 Docker volume `theater-data`（容器内 `/data/theater.db`）
- 改端口：编辑 `docker-compose.yml` 里的 `"8000:8000"`，例如 `"18000:8000"`

停止：

```bash
docker compose down        # 保留数据
docker compose down -v     # 同时删除数据卷
```

### 本地直接运行（不用 Docker）

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

可选环境变量：`DB_PATH=/path/to/theater.db`。

---

## 用法

1. **首页**：新建剧目（如《雷雨》第三幕联排），或从 JSON 导入。
2. 进入剧目后：
   - **＋ 新增场次**，用每行右侧的 `↑ / ↓ / ✎ / ✕` 调整顺序、重命名、删除；
   - **双击场次轨道空白处**在该时间点添加「动作」（🎬）；
     **Shift + 双击**添加「音效」（🔊）；
   - **拖拽色块**沿时间轴移动（0.5 秒吸附）；**拖右边缘**修改时长；
   - **把色块拖到另一行**即跨场次移动；
   - 右上角 `− / +` 或 **Ctrl/⌘ + 滚轮**缩放时间轴；
3. 把链接发给同一网络的同事，头像区可看到在线成员；编辑通过 WebSocket 实时广播。
4. **离线**（断网/休眠）时界面显示「离线（编辑已排队）」，所有操作进入浏览器本地队列；
   恢复连接后批量补发，队列计数归零。
5. 底部 **冲突与回收站** 面板列出所有并发冲突：显示各端操作、Lamport 时间戳、
   当前生效方；删除可一键恢复。
6. 顶栏 **导出 JSON / 导入 JSON** 用于备份、交换剧目或事后复盘。

JSON 导出既包含**物化状态**（场次/动作/音效），也包含**完整操作日志（ops）**，
导入时以操作日志为准重放，保证结构与冲突信息一致。

---

## 一致性模型（核心设计）

每个编辑是一条不可变操作（CRDT 风格的操作日志 + 确定性归约）：

```jsonc
{
  "id": "c-abc123:42",       // 全局唯一（客户端id:本地序号）
  "play_id": "...",
  "client_id": "c-abc123",
  "lamport": 42,             // Lamport 逻辑时钟
  "vector": {"c-abc123": 7, "c-def456": 3}, // 版本向量
  "target": "cue",           // scene | cue
  "op": "move",              // add | move | update | remove | restore
  "entity_id": "q-...",
  "payload": {"start": 32.5}
}
```

- **Lamport 时钟**：本地每发一条 `+1`；收到远端操作先 `L = max(L, remote) + 1`。
- **版本向量**：维护 `{客户端: 计数器}`，向量可比较 `v ≤ w` 判定**因果先于**，
  互相不可比较即为**并发**。
- **断线队列**：离线期间操作照常生成（带当时的 lamport/向量），写入
  `localStorage`；重连后整批通过 WebSocket（失败则 REST 回退）补发，服务端按
  操作 `id` 幂等去重。
- **合并**：服务端只做「追加 + 广播」，客户端与服务端用**同一份归约算法**
  （Python：`app/sync.py`；JS 镜像：`static/js/sync.js`）从操作集合重算状态。
- **确定性冲突裁决**：
  1. 所有操作按全序 `(lamport, client_id, op_id)` 排序；
  2. 同一元素上**并发且效果分歧**的写操作标记为冲突（UI 红框闪烁 + 面板详情）；
  3. 裁决规则对所有副本一致：默认取全序最后的写入者；
     **删除永远压过并发的移动/修改**——并发移动不会把已删除元素静默复活，
     必须显式「恢复」。因此任何两个客户端拿到同一操作集合，时间线顺序与
     冲突集合必然相同（最终一致 + 强确定性）。
- 场次顺序用浮点 `order`（相邻取中点），平局再按创建 Lamport、实体 id 排序；
  音效/动作在场次内按 `start` 时间排序（平局按创建 Lamport、id）。

---

## HTTP / WebSocket 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/plays` | 新建剧目 |
| `GET` | `/api/plays` | 剧目列表（含场次/音效数、在线人数、冲突数） |
| `GET` | `/api/plays/{id}` | 剧目 + 物化状态 + 冲突 + 在线快照 |
| `PATCH` | `/api/plays/{id}` | 重命名 |
| `GET` | `/api/plays/{id}/ops?after=N` | 增量拉取操作（seq > N） |
| `POST` | `/api/plays/{id}/ops` | 单条操作（REST 回退通道） |
| `GET` | `/api/plays/{id}/export` | 导出 JSON |
| `POST` | `/api/plays/import` | 导入 JSON（实体 id 自动重映射，永不与现有数据碰撞） |
| `WS` | `/ws/{id}` | 实时通道：`hello` / `welcome` / `op` / `ops` / `ack` / `presence` / `ping` |

WebSocket 重连后服务端在 `welcome` 中下发该剧目全量操作，客户端按 id 去重后重放，
因此不会因漏消息而分叉。

---

## 目录结构

```
.
├── app/
│   ├── main.py        # FastAPI：REST + WebSocket + 静态托管
│   ├── sync.py        # 规范归约引擎（向量时钟/冲突检测/导出）
│   ├── db.py          # SQLite：plays / members / ops / presence
│   └── ws_manager.py  # 按剧目房间的连接管理与广播
├── static/
│   ├── index.html     # 剧目列表
│   ├── play.html      # 时间线工作台
│   ├── css/style.css
│   └── js/
│       ├── sync.js    # sync.py 的 JS 镜像（必须保持语义一致）
│       ├── client.js  # Lamport/向量/离线队列/WebSocket 重连
│       ├── play.js    # 时间线渲染与手势
│       ├── home.js
│       └── utils.js
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

## 说明与边界

- 单容器部署、无鉴权，适合排练厅局域网/内网使用。
- 操作日志无限追加（排练规模下体量很小）；JSON 导出可用于归档后新建剧目。
- 现代浏览器（Chrome/Edge/Firefox/Safari 最新版）。
