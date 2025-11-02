# backend/main.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from supabase import create_client
from dotenv import load_dotenv
import os
from fastapi import File, UploadFile, Form
from xf_asr import transcribe_audio_bytes
from llm import generate_travel_plan

# 加载环境变量，明确从 backend/.env 读取
from pathlib import Path
load_dotenv(dotenv_path=str(Path(__file__).with_name('.env')))

# 初始化 FastAPI
app = FastAPI(title="AI Travel Planner Backend")


from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite 默认端口
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 初始化 Supabase 客户端
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_ANON_KEY")
if not supabase_url or not supabase_key:
    raise ValueError("Supabase URL or Anon Key is missing. Check your environment variables.")

supabase = create_client(supabase_url, supabase_key)

# 数据模型
class UserLogin(BaseModel):
    email: str
    password: str

@app.get("/")
def root():
    return {"message": "AI Travel Planner Backend is running!"}

@app.post("/signup")
def signup(user: UserLogin):# 自动验证 user 数据
    try:
        response = supabase.auth.sign_up({
            "email": user.email,
            "password": user.password
        })
        return {
            "user_id": response.user.id,
            "email": response.user.email,
            "message": "Signup successful"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Signup failed: {str(e)}")

@app.post("/signin")
def signin(user: UserLogin):
    try:
        response = supabase.auth.sign_in_with_password({
            "email": user.email,
            "password": user.password
        })
        return {
            "user_id": response.user.id,
            "access_token": response.session.access_token,
            "message": "Signin successful"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Signin failed: {str(e)}")

@app.post("/asr")
async def asr(audio: UploadFile = File(...), user_id: str | None = Form(default=None)):
    try:
        # 打印接收到的文件信息
        print("=== Received Audio File ===")
        print("Filename:", audio.filename)
        print("Content-Type:", audio.content_type)
        print("Size (bytes):", audio.size)

        audio_bytes = await audio.read()
        text = transcribe_audio_bytes(audio_bytes)
        if not text:
            raise HTTPException(status_code=500, detail="ASR returned empty result")

        # 可选：写入 Supabase，如果携带了 user_id
        if user_id:
            try:
                supabase.table("voice_texts").insert({
                    "user_id": user_id,
                    "text": text,
                }).execute()
            except Exception:
                # 不阻断返回
                pass

        return {"text": text}
    except Exception as e:
        print("❌ ASR Error:", str(e))
        raise HTTPException(status_code=500, detail=f"ASR error: {str(e)}")


@app.get("/history")
def history(user_id: str):
    try:
        # 查询 travel_plans 表（包含 transcript 和 plan_text）
        try:
            data = supabase.table("travel_plans").select("id, transcript, plan_text, created_at").eq("user_id", user_id).order("created_at", desc=True).execute()
            rows = data.data or []
            # 将字段名转换为前端期望的格式
            items = []
            for row in rows:
                items.append({
                    "id": row.get("id"),
                    "text": row.get("transcript", ""),  # 显示ASR结果
                    "plan": row.get("plan_text", ""),  # 行程内容
                    "created_at": row.get("created_at")
                })
            return {"items": items}
        except Exception:
            # 如果 travel_plans 表不存在，回退到 voice_texts 表
            data = supabase.table("voice_texts").select("id, text, created_at").eq("user_id", user_id).order("created_at", desc=True).execute()
            rows = data.data or []
            # 为兼容性，添加空的 plan 字段
            items = []
            for row in rows:
                items.append({
                    "id": row.get("id"),
                    "text": row.get("text", ""),
                    "plan": "",  # 没有行程数据
                    "created_at": row.get("created_at")
                })
            return {"items": items}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Fetch history failed: {str(e)}")



class TravelRequest(BaseModel):
    user_input: str  # e.g., "我想去日本东京玩5天，预算1万元，带孩子，喜欢美食和动漫"

@app.post("/plan")
def create_travel_plan(request: TravelRequest):
    try:
        plan_text = generate_travel_plan(request.user_input)
        return {"plan": plan_text}
    except Exception as e:
        raise HTTPException(400, detail=f"LLM failed: {str(e)}")


@app.post("/asr_and_plan")
async def asr_and_plan(
    audio: UploadFile = File(...),
    user_id: str | None = Form(default=None)
):
    try:
        # 1. 读取音频
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")

        # 2. 调用 ASR
        transcript = transcribe_audio_bytes(audio_bytes)
        if not transcript:
            raise HTTPException(status_code=500, detail="ASR returned empty result")

        # 3. 调用 LLM 生成中文文本行程（模块2）
        plan_text = generate_travel_plan(transcript)        
        
        # 4. （可选）存入 Supabase
        if user_id:
            try:
                supabase.table("travel_plans").insert({
                    "user_id": user_id,
                    "transcript": transcript,
                    "plan_text": plan_text  # 注意：字段名是 plan_text（字符串）
                }).execute()
            except Exception as db_err:
                print("⚠️ Warning: Failed to save plan to Supabase:", str(db_err))

        # 5. 返回结果
        return {
            "transcript": transcript,
            "plan": plan_text  # 纯字符串
        }

    except Exception as e:
        print("❌ ASR + Plan Error:", str(e))
        raise HTTPException(status_code=500, detail=f"ASR or LLM failed: {str(e)}")