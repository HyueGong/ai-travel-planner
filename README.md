# AI Travel Planner

基于 FastAPI + React 的智能旅行规划助手，支持语音输入、AI 自动生成个性化旅行计划，并提供高交互性的预算管理与语音记账体验。

## 核心功能

-  **语音识别**：基于科大讯飞 ASR 提供语音输入功能
-  **AI 行程规划**：使用 DeepSeek 大语言模型自动生成详细旅行计划（包含交通、住宿、景点、餐厅等）
-  **用户认证**：基于 Supabase Auth 的注册登录系统
-  **云端存储**：行程数据自动同步到 Supabase，支持多设备访问
-  **历史记录**：查看和管理所有生成的旅行计划，点击即可重新加载文本与地图
-  **地图可视化**：基于高德地图展示行程路线与关键地点，支持标记、信息窗与路径连线
-  **预算管理**：创建旅行预算、查看实时剩余、分类统计
-  **语音记账**：通过语音快速记录开销，AI 自动识别金额、类别与币种

## 技术栈

- **后端**：FastAPI + Python
- **前端**：React + Vite + 高德地图 JS SDK
- **语音识别**：科大讯飞 IAT WebSocket API
- **AI 模型**：DeepSeek Chat API
- **数据库/认证**：Supabase (Auth + PostgreSQL)

## 目录结构

```
ai-travel-planner/
├── backend/                       # FastAPI 服务
│   ├── main.py                    # API 入口：行程生成、历史、预算、记账
│   ├── llm.py                     # DeepSeek LLM 客户端与 JSON 解析修正
│   ├── xf_asr.py                  # 讯飞实时语音识别封装
│   ├── requirements.txt           # 后端依赖
│   └── env.example                # 后端环境变量示例
├── frontend/                      # React + Vite 前端
│   ├── package.json
│   ├── vite.config.js
│   ├── env.example                # 前端环境变量示例（高德 Key）
│   ├── public/
│   │   └── vite.svg
│   └── src/
│       ├── main.jsx               # React 入口，挂载 App
│       ├── App.jsx                # 主界面（行程 / 预算双面板）
│       ├── App.css
│       ├── index.css
│       ├── MapView.jsx            # 高德地图展示行程线路
│       ├── mapLoader.js           # 高德地图 SDK 加载与缓存逻辑
│       ├── BudgetPanel.jsx        # 预算管理与记账界面
│       ├── Login.jsx              # Supabase 认证入口
│       ├── audioUtils.js          # 浏览器录音 & 音频处理
│       └── assets/
│           └── react.svg
├── docker/
│   ├── Dockerfile.backend         # FastAPI 镜像构建文件
│   └── Dockerfile.frontend        # 前端静态资源构建文件
├── docker-compose.yml             # 一键启动编排配置
└── README.md
```


## 快速开始

### 方式一： Docker 一键启动

1. 准备环境变量：
   - 将 `backend/env.example` 复制为 `backend/.env`，并按 PDF 中提供的值填写 Supabase、DeepSeek、科大讯飞等密钥。
   - 将 `frontend/env.example` 复制为 `frontend/.env`，填入高德地图 Web Key（`VITE_AMAP_KEY`）。
2. 确保本机已安装 Docker（包含 Docker Compose 插件）。
3. 运行：

```bash
docker compose up --build
```

4. 浏览器访问 `http://localhost:5173`，后端 API 位于 `http://localhost:8000`。

停止服务可执行：

```bash
docker compose down
```

### 方式二：直接运行预构建镜像（推荐）

1. 创建 `.env` 文件（含 DeepSeek、讯飞、Supabase Key）
2. 启动服务：

```bash
# 启动后端
docker run -d \
  --name ai-travel-backend \
  -p 8000:8000 \
  --env-file .env \
  crpi-ku07xl4d7pm543bf.cn-hangzhou.personal.cr.aliyuncs.com/hyuegong/ai-travel-planner-backend:latest

# 启动前端
docker run -d \
  --name ai-travel-frontend \
  -p 80:80 \
  crpi-ku07xl4d7pm543bf.cn-hangzhou.personal.cr.aliyuncs.com/hyuegong/ai-travel-planner-frontend:latest
```

## 使用说明

1. **注册/登录**：首次使用需要注册账号（Supabase Auth），成功后会自动拉取历史行程。
2. **语音输入**：点击“开始录音”，说出旅行需求（例：“我想去成都玩 5 天，预算 1 万元，带父母”），结束后等待识别和生成。
3. **文本输入**：也可在文本区域直接录入旅行需求（如“东京亲子游 4 天 8000 元”），提交后返回结构化行程。
4. **查看行程与地图**：
   - 生成成功后右侧展示完整日程卡片、预算概览与地图；地图会自动聚焦首个带经纬度的地点。
   - 点击行程中的任意地点可在地图上聚焦标记，查看信息窗并高亮对应日程。
5. **历史记录**：左侧列表会保存所有生成过的行程，点击可重新加载文本与地图；支持删除无用记录。
6. **预算管理**：
   - 切换到“预算”标签创建预算（可选关联行程），实时查看剩余金额与分类统计。
   - 支持手动记账或语音记账（示例：“刚才在东京塔门票花了 2400 日元”），系统会自动识别金额和类别。

## API 接口

### 用户/行程

- `POST /signup` — 用户注册
- `POST /signin` — 用户登录
- `POST /asr` — 仅语音识别（不生成行程）
- `POST /plan` — 仅生成旅行计划（传入文本）
- `POST /asr_and_plan` — 语音识别 + 生成旅行计划（主要接口）
- `GET /history?user_id=xxx` — 获取行程历史（返回 transcript、plan_text 及 `plan_structured`，前端据此渲染卡片与地图）
- `DELETE /travel_plans/{id}?user_id=xxx` — 删除指定行程（及其在历史列表中的展示）

### 预算管理

- `POST /budgets` — 创建预算（支持 `plan_id` 关联 `travel_plans`）
- `GET /budgets?user_id=xxx` — 获取用户所有预算
- `PATCH /budgets/{id}` — 更新预算（金额、备注、关联行程等）
- `DELETE /budgets/{id}` — 删除预算
- `POST /expenses` — 新增开销（JSON 传金额、类别、描述）
- `POST /expenses/voice` — 上传语音，自动识别金额/币种/类别后记账
- `GET /expenses?user_id=xxx&budget_id=yyy` — 获取预算详情、剩余金额与分类统计

返回的金额字段均为数值，单位由 `currency` 指定（默认 `CNY`）；语音记账会在 `transcript` 字段保留原始识别文本。


## 注意事项

- 语音识别功能请在安静室内环境中使用，否则容易识别失败或识别错误
- 确保网络连接正常，AI 生成行程与语音识别均依赖外部 API
