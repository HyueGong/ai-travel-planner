# AI Travel Planner

基于 FastAPI + React 的智能旅行规划助手，支持语音输入、AI 自动生成个性化旅行计划。

## 核心功能

-  **语音识别**：基于科大讯飞 ASR 提供语音输入功能
-  **AI 行程规划**：使用 DeepSeek 大语言模型自动生成详细旅行计划（包含交通、住宿、景点、餐厅等）
-  **用户认证**：基于 Supabase Auth 的注册登录系统
-  **云端存储**：行程数据自动同步到 Supabase，支持多设备访问
-  **历史记录**：查看和管理所有生成的旅行计划

## 技术栈

- **后端**：FastAPI + Python
- **前端**：React + Vite
- **语音识别**：科大讯飞 IAT WebSocket API
- **AI 模型**：DeepSeek Chat API
- **数据库/认证**：Supabase (Auth + PostgreSQL)

## 目录结构

```
ai-travel-planner/
├── backend/          # FastAPI 后端
│   ├── main.py      # 主应用入口
│   ├── xf_asr.py    # 科大讯飞 ASR 封装
│   ├── llm.py       # DeepSeek LLM 封装
│   └── requirements.txt
└── frontend/         # React 前端
    └── src/
        ├── App.jsx   # 主应用组件
        └── Login.jsx # 登录组件
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
2. **语音输入**：点击"开始录音"按钮，说出你的旅行需求
   - 例如："我想去日本东京玩5天，预算1万元，带孩子，喜欢美食和动漫"
3. **查看行程**：录音结束后，AI 会自动识别并生成详细旅行计划
4. **历史记录**：左侧历史记录栏可查看所有已生成的行程，点击可查看详情

## API 接口

- `POST /signup` - 用户注册
- `POST /signin` - 用户登录
- `POST /asr` - 仅语音识别（不生成行程）
- `POST /asr_and_plan` - 语音识别 + 生成旅行计划（主要接口）
- `POST /plan` - 仅生成旅行计划（传入文本）
- `GET /history?user_id=xxx` - 获取用户历史记录


## 注意事项

- 前端录音会自动重采样到 16kHz 并归一化处理
- 后端使用讯飞 IAT WebSocket 分片上传并聚合最终结果
- 确保网络连接正常，AI 生成行程需要调用外部 API
