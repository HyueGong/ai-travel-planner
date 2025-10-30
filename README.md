# AI Travel Planner

基于 FastAPI + React 的语音输入旅行助手（Supabase 账户体系与数据存储、科大讯飞 IAT 识别）。

## 目录结构
- `backend/` 后端（FastAPI）
- `frontend/` 前端（Vite + React）

## 环境准备
1) 在 Supabase 获取并配置环境变量（写入 `backend/.env`）：
```
SUPABASE_URL=你的SupabaseURL
SUPABASE_ANON_KEY=你的SupabaseAnonKey
XF_APPID=你的讯飞APPID
XF_API_KEY=你的讯飞APIKey
XF_API_SECRET=你的讯飞APISecret
```
2) Supabase 表结构（手动创建）：
```
表名: voice_texts
列: id (uuid/serial PK), user_id (text), text (text), created_at (timestamp default now())
```
如开启 RLS，请给登录用户授予对 `voice_texts` 的读写策略。

## 启动后端
```bash
cd backend
pip install -r requirements.txt
cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```
健康检查：`GET http://localhost:8000/`

## 启动前端
```bash
cd frontend
npm install
npm run dev
```
打开浏览器访问 `http://localhost:5173`

## 使用说明
1) 进入登录页：支持注册/登录（Supabase Auth）。
2) 登录成功后进入主界面：
   - 顶部居中标题；
   - 标题下方显示当前用户与“退出”；
   - 左侧 1/3 为历史记录；右侧 2/3 为语音识别区；
   - 点击“开始录音/停止录音”，识别成功自动写入 `voice_texts` 并刷新历史。

## API 简述
- `POST /signup`、`POST /signin`：调用 Supabase Auth 注册/登录，返回 `user_id`。
- `POST /asr`（multipart/form-data）
  - 字段：`audio`（WAV 文件），`user_id`（可选，携带则入库）
  - 返回：`{"text": "..."}`
- `GET /history?user_id=...`：返回该用户识别历史。

## 备注
- 前端录音会重采样到 16kHz 并归一化；后端使用讯飞 IAT WebSocket 分片上传并聚合最终结果。
- 可以使用 `backend/test.wav` 本地测试 ASR 接口（如不需要可删除）。
