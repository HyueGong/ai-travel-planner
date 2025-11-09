# backend/main.py
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from supabase import create_client
from dotenv import load_dotenv
import os
from xf_asr import transcribe_audio_bytes
from llm import generate_travel_plan
from typing import Optional, List, Dict
from decimal import Decimal, InvalidOperation
import re

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


class BudgetCreate(BaseModel):
    user_id: str
    total_budget: Decimal = Field(..., gt=0)
    currency: str = "CNY"
    notes: Optional[str] = None
    plan_id: Optional[int] = None  # travel_plans.id 是 bigint


class BudgetUpdate(BaseModel):
    total_budget: Optional[Decimal] = Field(default=None, gt=0)
    currency: Optional[str] = None
    notes: Optional[str] = None
    plan_id: Optional[int] = None


class ExpenseCreate(BaseModel):
    user_id: str
    budget_id: str
    category: str
    amount: Decimal = Field(..., ge=0)
    currency: str = "CNY"
    description: Optional[str] = None
    transcript: Optional[str] = None
    source: str = "text"  # text | voice
@app.post("/plan")
def create_travel_plan(request: TravelRequest):
    try:
        plan_text = generate_travel_plan(request.user_input)
        return {"plan": plan_text}
    except Exception as e:
        raise HTTPException(400, detail=f"LLM failed: {str(e)}")


@app.post("/budgets")
def create_budget(payload: BudgetCreate):
    try:
        data = payload.model_dump()
        # Supabase 不接受 Decimal，转换为 float
        data["total_budget"] = float(data["total_budget"])
        response = supabase.table("budgets").insert(data).execute()
        created = (response.data or [None])[0]
        if not created:
            raise HTTPException(status_code=500, detail="Failed to create budget")
        return created
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Create budget failed: {str(e)}")


@app.get("/budgets")
def list_budgets(user_id: str):
    try:
        response = (
            supabase.table("budgets")
            .select("*")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .execute()
        )
        return {"items": response.data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fetch budgets failed: {str(e)}")


@app.patch("/budgets/{budget_id}")
def update_budget(budget_id: str, payload: BudgetUpdate, user_id: str):
    try:
        update_data = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
        if not update_data:
            return {"id": budget_id, "message": "No changes applied"}
        if "total_budget" in update_data:
            update_data["total_budget"] = float(update_data["total_budget"])
        response = (
            supabase.table("budgets")
            .update(update_data)
            .eq("id", budget_id)
            .eq("user_id", user_id)
            .execute()
        )
        updated = (response.data or [None])[0]
        if not updated:
            raise HTTPException(status_code=404, detail="Budget not found")
        return updated
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Update budget failed: {str(e)}")


@app.delete("/budgets/{budget_id}")
def delete_budget(budget_id: str, user_id: str):
    try:
        response = (
            supabase.table("budgets")
            .delete()
            .eq("id", budget_id)
            .eq("user_id", user_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Budget not found")
        return {"message": "Budget deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete budget failed: {str(e)}")


@app.post("/expenses")
def create_expense(payload: ExpenseCreate):
    try:
        budget_id = payload.budget_id
        user_id = payload.user_id
        _ensure_budget_owner(budget_id, user_id)
        data = payload.model_dump()
        data["amount"] = float(data["amount"])
        response = supabase.table("expenses").insert(data).execute()
        created = (response.data or [None])[0]
        if not created:
            raise HTTPException(status_code=500, detail="Failed to create expense")
        return created
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Create expense failed: {str(e)}")


@app.get("/expenses")
def list_expenses(user_id: str, budget_id: str):
    try:
        budget = _ensure_budget_owner(budget_id, user_id)
        response = (
            supabase.table("expenses")
            .select("*")
            .eq("budget_id", budget_id)
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .execute()
        )
        items = response.data or []
        total_spent = sum(_decimal_to_float(item.get("amount")) or 0 for item in items)
        category_totals: Dict[str, float] = {}
        for item in items:
            category = item.get("category") or "other"
            amount = _decimal_to_float(item.get("amount")) or 0
            category_totals[category] = category_totals.get(category, 0) + amount
        remaining = None
        budget_amount = _decimal_to_float(budget.get("total_budget"))
        if budget_amount is not None:
            remaining = budget_amount - total_spent
        return {
            "budget": budget,
            "items": items,
            "total_spent": total_spent,
            "remaining": remaining,
            "currency": budget.get("currency", "CNY"),
            "by_category": category_totals,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fetch expenses failed: {str(e)}")


@app.post("/expenses/voice")
async def create_expense_from_voice(
    budget_id: str = Form(...),
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    currency_hint: Optional[str] = Form(default=None),
    fallback_category: Optional[str] = Form(default=None),
):
    try:
        _ensure_budget_owner(budget_id, user_id)
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")
        transcript = transcribe_audio_bytes(audio_bytes)
        if not transcript:
            raise HTTPException(status_code=500, detail="ASR returned empty result")
        parsed = _parse_expense_from_text(transcript)
        amount = parsed.get("amount")
        if amount is None:
            raise HTTPException(status_code=400, detail="无法从语音中识别金额，请手动输入")
        currency = currency_hint or parsed.get("currency") or "CNY"
        category = fallback_category or parsed.get("category") or "other"
        data = {
            "budget_id": budget_id,
            "user_id": user_id,
            "category": category,
            "amount": float(amount),
            "currency": currency,
            "description": transcript,
            "transcript": transcript,
            "source": "voice",
        }
        response = supabase.table("expenses").insert(data).execute()
        created = (response.data or [None])[0]
        if not created:
            raise HTTPException(status_code=500, detail="Failed to create expense")
        created["transcript"] = transcript
        return created
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Create voice expense failed: {str(e)}")


@app.delete("/travel_plans/{plan_id}")
def delete_travel_plan(plan_id: int, user_id: str):
    try:
        response = (
            supabase.table("travel_plans")
            .delete()
            .eq("id", plan_id)
            .eq("user_id", user_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Travel plan not found")
        return {"message": "Travel plan deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete travel plan failed: {str(e)}")


def _decimal_to_float(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ensure_budget_owner(budget_id: str, user_id: str):
    budget_res = (
        supabase.table("budgets")
        .select("*")
        .eq("id", budget_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = budget_res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Budget not found")
    return rows[0]


def _parse_amount(text: str) -> Optional[Decimal]:
    if not text:
        return None
    pattern = r"(\d+(?:\.\d+)?)"
    match = re.search(pattern, text.replace(",", ""))
    if not match:
        return None
    try:
        return Decimal(match.group(1))
    except (InvalidOperation, ValueError):
        return None


def _detect_currency(text: str) -> Optional[str]:
    if not text:
        return None
    currency_map = {
        "美元": "USD",
        "美金": "USD",
        "usd": "USD",
        "日元": "JPY",
        "日幣": "JPY",
        "日币": "JPY",
        "日圓": "JPY",
        "韩元": "KRW",
        "韓元": "KRW",
        "欧元": "EUR",
        "歐元": "EUR",
        "英镑": "GBP",
        "英鎊": "GBP",
        "港币": "HKD",
        "港幣": "HKD",
        "人民币": "CNY",
        "人民幣": "CNY",
        "rmb": "CNY",
        "元": "CNY",
        "块": "CNY",
        "块钱": "CNY",
    }
    lowered = text.lower()
    for keyword, code in currency_map.items():
        if keyword in text or keyword in lowered:
            return code
    return None


def _detect_category(text: str) -> str:
    if not text:
        return "other"
    category_keywords = [
        ("food", ["餐", "吃", "饭", "早餐", "午餐", "晚餐", "小吃", "美食", "咖啡", "餐厅", "酒吧"]),
        ("transport", ["地铁", "飞机", "火车", "打车", "出租", "公交", "高铁", "车票", "交通", "公交卡", "机票"]),
        ("hotel", ["酒店", "住宿", "民宿", "旅馆", "客栈", "入住"]),
        ("shopping", ["购物", "买", "购买", "纪念品", "特产", "伴手礼", "礼物"]),
        ("entertainment", ["门票", "景点", "游玩", "娱乐", "乐园", "演出", "展览", "体验"]),
        ("other", []),
    ]
    for category, keywords in category_keywords:
        if any(keyword in text for keyword in keywords):
            return category
    return "other"


def _parse_expense_from_text(text: str) -> Dict[str, Optional[str]]:
    amount = _parse_amount(text)
    currency = _detect_currency(text)
    category = _detect_category(text)
    return {
        "amount": amount,
        "currency": currency,
        "category": category,
    }


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