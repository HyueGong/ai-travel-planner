# backend/main.py
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from supabase import create_client
from dotenv import load_dotenv
import os
from .xf_asr import transcribe_audio_bytes
from .llm import generate_structured_travel_plan
from typing import Optional, List, Dict
from decimal import Decimal, InvalidOperation
import re
import json
import requests

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
amap_web_key = os.getenv("AMAP_WEB_KEY") or os.getenv("AMAP_REST_KEY")

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
            data = supabase.table("travel_plans").select("id, transcript, plan_text, plan_structured, created_at").eq("user_id", user_id).order("created_at", desc=True).execute()
            if getattr(data, "error", None):
                # 兼容旧 schema（缺少 plan_structured 字段）
                print("⚠️ Supabase history select error, retrying without plan_structured:", data.error)
                data = supabase.table("travel_plans").select("id, transcript, plan_text, created_at").eq("user_id", user_id).order("created_at", desc=True).execute()
            rows = data.data or []
            # 将字段名转换为前端期望的格式
            items = []
            for row in rows:
                structured = None
                raw_structured = row.get("plan_structured")
                if isinstance(raw_structured, dict):
                    structured = raw_structured
                elif isinstance(raw_structured, str):
                    try:
                        structured = json.loads(raw_structured)
                    except json.JSONDecodeError:
                        structured = None
                items.append({
                    "id": row.get("id"),
                    "text": row.get("transcript", ""),  # 显示ASR结果
                    "plan": row.get("plan_text", ""),  # 行程内容
                    "plan_structured": structured,
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
                    "plan_structured": None,
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


_geocode_cache: Dict[str, Optional[tuple[float, float]]] = {}


def geocode_with_amap(address: Optional[str], city: Optional[str] = None) -> Optional[tuple[float, float]]:
    if not amap_web_key or not address:
        return None
    query = address.strip()
    if not query:
        return None
    cache_key = f"{query}|{city or ''}"
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]
    params = {
        "key": amap_web_key,
        "address": query,
    }
    if city:
        params["city"] = city
    try:
        resp = requests.get("https://restapi.amap.com/v3/geocode/geo", params=params, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "1" and data.get("geocodes"):
            location = data["geocodes"][0].get("location")
            if location:
                try:
                    lng_str, lat_str = location.split(",")
                    lng = float(lng_str)
                    lat = float(lat_str)
                    _geocode_cache[cache_key] = (lng, lat)
                    return _geocode_cache[cache_key]
                except (ValueError, AttributeError):
                    pass
    except Exception as exc:
        print(f"⚠️ Geocode failed for {query} ({city}): {exc}")
    _geocode_cache[cache_key] = None
    return None


def enrich_plan_with_coordinates(plan: Optional[dict]) -> Optional[dict]:
    if not isinstance(plan, dict):
        return plan
    destination = plan.get("overview", {}).get("destination")
    days = plan.get("days") or []
    for day in days:
        day_city = day.get("city") if isinstance(day, dict) else None
        items = day.get("items") if isinstance(day, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("longitude") and item.get("latitude"):
                continue
            address = item.get("address") or item.get("name")
            city = item.get("city") or day_city or destination
            coords = geocode_with_amap(address, city)
            if coords:
                lng, lat = coords
                item["longitude"] = lng
                item["latitude"] = lat
                item["coordinate_source"] = "amap_geocode"
    return plan


def structured_plan_to_text(plan: Optional[dict]) -> str:
    if not isinstance(plan, dict):
        return ""
    lines: List[str] = []
    overview = plan.get("overview") or {}
    if overview:
        lines.append("【旅行计划概览】")
        destination = overview.get("destination")
        if destination:
            lines.append(f"目的地：{destination}")
        if overview.get("days") is not None:
            lines.append(f"天数：{overview.get('days')}")
        if overview.get("travelers"):
            lines.append(f"同行：{overview.get('travelers')}")
        budget = overview.get("budget") or {}
        if budget.get("total") is not None:
            currency = budget.get("currency") or "CNY"
            lines.append(f"预算：{currency} {budget.get('total')}")
        highlights = overview.get("highlights") or []
        if highlights:
            lines.append("亮点：")
            for item in highlights:
                lines.append(f"- {item}")
        lines.append("")
    budget_breakdown = plan.get("budget_breakdown") or []
    if budget_breakdown:
        lines.append("【预算分配】")
        for bucket in budget_breakdown:
            category = bucket.get("category", "其他")
            amount = bucket.get("amount")
            description = bucket.get("description")
            if amount is not None:
                lines.append(f"- {category}：{amount}（{description or '详情'}）")
            else:
                lines.append(f"- {category}：{description or '详情待确认'}")
        lines.append("")
    days = plan.get("days") or []
    if days:
        lines.append("【每日行程】")
        for idx, day in enumerate(days, start=1):
            title = day.get("title") or f"第{idx}天"
            lines.append(title)
            summary = day.get("summary")
            if summary:
                lines.append(summary)
            accommodation = day.get("accommodation") or {}
            if accommodation.get("name"):
                lines.append(f"住宿：{accommodation.get('name')}（预算：{accommodation.get('budget', '待定')}）")
            meals = day.get("meals") or {}
            meal_lines = []
            for meal_key, label in (("breakfast", "早餐"), ("lunch", "午餐"), ("dinner", "晚餐")):
                if meals.get(meal_key):
                    meal_lines.append(f"{label}：{meals[meal_key]}")
            if meal_lines:
                lines.extend(meal_lines)
            items = day.get("items") or []
            for item in items:
                time = item.get("time") or ""
                name = item.get("name") or "活动"
                description = item.get("description") or ""
                budget = item.get("budget")
                time_prefix = f"{time} " if time else ""
                budget_suffix = f"（预算 {budget}）" if budget is not None else ""
                lines.append(f"{time_prefix}{name}：{description}{budget_suffix}")
            if day.get("total_budget") is not None:
                lines.append(f"当日花费：{day.get('total_budget')}")
            lines.append("")
    advice = plan.get("advice") or {}
    if advice:
        lines.append("【实用建议】")
        for key, label in (("preparation", "行前准备"), ("local_tips", "当地贴士"), ("money_saving", "省钱技巧"), ("safety", "安全提示")):
            items = advice.get(key) or []
            if items:
                lines.append(f"{label}：")
                for item in items:
                    lines.append(f"- {item}")
        lines.append("")
    emergency = plan.get("emergency") or {}
    if emergency:
        lines.append("【紧急联系】")
        if emergency.get("police"):
            lines.append(f"报警：{emergency.get('police')}")
        if emergency.get("medical"):
            lines.append(f"急救：{emergency.get('medical')}")
        if emergency.get("embassy"):
            lines.append(f"大使馆：{emergency.get('embassy')}")
        lines.append("")
    itinerary_text = plan.get("itinerary_text")
    if itinerary_text:
        lines.append("【行程详情】")
        lines.append(itinerary_text)
    return "\n".join(line for line in lines if line is not None)


def generate_travel_plan(user_input: str) -> str:
    structured = generate_structured_travel_plan(user_input)
    structured = enrich_plan_with_coordinates(structured)
    if isinstance(structured, dict):
        return structured.get("itinerary_text") or structured_plan_to_text(structured)
    return structured or ""


class TextPlanRequest(BaseModel):
    user_input: str
    user_id: Optional[str] = None


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

        # 3. 调用 LLM 生成结构化行程并补充坐标
        plan_structured = None
        plan_text = ""
        try:
            plan_structured = generate_structured_travel_plan(transcript)
            plan_structured = enrich_plan_with_coordinates(plan_structured)
            plan_text = plan_structured.get("itinerary_text") or structured_plan_to_text(plan_structured)
        except Exception as llm_err:
            print(f"❌ LLM structured plan failed: {llm_err}")
            plan_structured = None
            plan_text = f"抱歉，行程生成失败：{llm_err}"
        
        # 4. （可选）存入 Supabase
        if user_id:
            try:
                insert_payload = {
                    "user_id": user_id,
                    "transcript": transcript,
                    "plan_text": plan_text
                }
                if plan_structured is not None:
                    insert_payload["plan_structured"] = json.dumps(plan_structured, ensure_ascii=False)
                supabase.table("travel_plans").insert({**insert_payload}).execute()
            except Exception as db_err:
                print("⚠️ Warning: Failed to save plan to Supabase:", str(db_err))
                if "plan_structured" in insert_payload:
                    try:
                        fallback_payload = insert_payload.copy()
                        fallback_payload.pop("plan_structured", None)
                        supabase.table("travel_plans").insert({**fallback_payload}).execute()
                    except Exception as retry_err:
                        print("⚠️ Warning: Fallback insert without structured data also failed:", retry_err)

        # 5. 返回结果
        return {
            "transcript": transcript,
            "plan": plan_text,
            "plan_text": plan_text,
            "plan_structured": plan_structured
        }

    except Exception as e:
        print("❌ ASR + Plan Error:", str(e))
        raise HTTPException(status_code=500, detail=f"ASR or LLM failed: {str(e)}")


@app.post("/text_plan")
def text_plan(payload: TextPlanRequest):
    user_input = (payload.user_input or "").strip()
    if not user_input:
        raise HTTPException(status_code=400, detail="请输入旅行需求")
    try:
        plan_structured = None
        plan_text = ""
        try:
            plan_structured = generate_structured_travel_plan(user_input)
            plan_structured = enrich_plan_with_coordinates(plan_structured)
            if isinstance(plan_structured, dict):
                plan_text = plan_structured.get("itinerary_text") or structured_plan_to_text(plan_structured)
            else:
                plan_text = str(plan_structured) if plan_structured else ""
        except Exception as llm_err:
            print(f"❌ LLM text plan failed: {llm_err}")
            plan_structured = None
            plan_text = f"抱歉，行程生成失败：{llm_err}"

        if payload.user_id:
            try:
                insert_payload = {
                    "user_id": payload.user_id,
                    "transcript": user_input,
                    "plan_text": plan_text,
                }
                if plan_structured is not None:
                    insert_payload["plan_structured"] = json.dumps(plan_structured, ensure_ascii=False)
                supabase.table("travel_plans").insert({**insert_payload}).execute()
            except Exception as db_err:
                print("⚠️ Warning: Failed to save text plan to Supabase:", str(db_err))
                if "plan_structured" in insert_payload:
                    try:
                        fallback_payload = insert_payload.copy()
                        fallback_payload.pop("plan_structured", None)
                        supabase.table("travel_plans").insert({**fallback_payload}).execute()
                    except Exception as retry_err:
                        print("⚠️ Warning: Fallback insert without structured data also failed:", retry_err)

        return {
            "transcript": user_input,
            "plan": plan_text,
            "plan_text": plan_text,
            "plan_structured": plan_structured,
        }
    except HTTPException:
        raise
    except Exception as e:
        print("❌ Text plan Error:", str(e))
        raise HTTPException(status_code=500, detail=f"Text plan failed: {str(e)}")