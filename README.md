# AI Travel Planner

基于 FastAPI + React 的智能旅行规划助手，支持语音输入、AI 自动生成个性化旅行计划，并提供高交互性的预算管理与语音记账体验。

## 核心功能

-  **语音识别**：基于科大讯飞 ASR 提供语音输入功能
-  **AI 行程规划**：使用 DeepSeek 大语言模型自动生成详细旅行计划（包含交通、住宿、景点、餐厅等）
-  **用户认证**：基于 Supabase Auth 的注册登录系统
-  **云端存储**：行程数据自动同步到 Supabase，支持多设备访问
-  **历史记录**：查看和管理所有生成的旅行计划
-  **预算管理**：创建旅行预算、查看实时剩余、分类统计
-  **语音记账**：通过语音快速记录开销，AI 自动识别金额、类别与币种

## 技术栈

- **后端**：FastAPI + Python
- **前端**：React + Vite
- **语音识别**：科大讯飞 IAT WebSocket API
- **AI 模型**：DeepSeek Chat API
- **数据库/认证**：Supabase (Auth + PostgreSQL)

## 目录结构

```
ai-travel-planner/
├── backend/             # FastAPI 后端
│   ├── main.py          # 主应用入口 & API 定义（行程 + 预算）
│   ├── llm.py           # DeepSeek LLM 封装
│   ├── xf_asr.py        # 科大讯飞 ASR 封装
│   └── requirements.txt
└── frontend/            # React 前端
    └── src/
        ├── App.jsx          # 主应用组件（行程/预算双面板）
        ├── BudgetPanel.jsx  # 预算管理面板
        ├── audioUtils.js    # 录音处理工具
        └── Login.jsx        # 登录组件
```


## 快速开始

### 启动后端

```bash
cd backend
pip install -r requirements.txt
cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

健康检查：访问 `http://localhost:8000/`

### 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开浏览器访问 `http://localhost:5173`

## 使用说明

1. **注册/登录**：首次使用需要注册账号（Supabase Auth）
2. **语音输入**：点击“开始录音”，说出旅行需求（例：“我想去日本东京玩 5 天，预算 1 万元，带孩子”）
3. **查看行程**：录音结束后，AI 自动识别并生成详细旅行计划，可在历史记录中再次查看
4. **预算管理**：
   - 切换到“预算”标签，创建预算（可选择关联某个行程）
   - 在预算页面直接填写或语音记账，系统会实时更新剩余预算和分类统计
   - 语音记账示例：“刚才在东京塔门票花了 2400 日元”

## API 接口

### 用户/行程

- `POST /signup` — 用户注册
- `POST /signin` — 用户登录
- `POST /asr` — 仅语音识别（不生成行程）
- `POST /plan` — 仅生成旅行计划（传入文本）
- `POST /asr_and_plan` — 语音识别 + 生成旅行计划（主要接口）
- `GET /history?user_id=xxx` — 获取用户历史记录
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

- 前端录音自动重采样到 16kHz、裁剪静音并归一化，确保语音识别质量
- 语音记账若无法识别金额，后端会返回错误提示，用户可改用手动录入
- Supabase 需提前创建 `budgets` 与 `expenses` 表，并与 `travel_plans` 建立外键；详见 `backend/main.py`
- 行程历史会在预算面板中列出，便于直接关联预算
- 确保网络连接正常，AI 生成行程与语音识别均依赖外部 API
