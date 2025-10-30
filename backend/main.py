# backend/main.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from supabase import create_client
from dotenv import load_dotenv
import os
from fastapi import File, UploadFile, Form
from .xf_asr import transcribe_audio_bytes

# 加载环境变量，明确从 backend/.env 读取
import os
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
        data = supabase.table("voice_texts").select("id, text, created_at").eq("user_id", user_id).order("created_at", desc=True).execute()
        rows = data.data or []
        return {"items": rows}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Fetch history failed: {str(e)}")