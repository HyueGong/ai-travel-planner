from openai import OpenAI
import os
from dotenv import load_dotenv
import json
import re

load_dotenv()

def get_llm_client():
    provider = os.getenv("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return OpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY"),
            base_url="https://api.deepseek.com"
        )
    # 可扩展其他模型...
    else:
        raise ValueError("Unsupported LLM provider")

def generate_structured_travel_plan(user_input: str) -> dict:
    client = get_llm_client()
    
    prompt = f"""
你是一名中文旅行规划师。请阅读以下用户需求，并返回一个 **合法 JSON 字符串**，严格符合下面的 JSON Schema。

用户需求：{user_input}

JSON Schema（示例，仅用于说明结构）：
{{
  "overview": {{
    "destination": "字符串，目的地名称",
    "days": "整数天数",
    "travelers": "字符串描述同行人数",
    "budget": {{
      "currency": "字符串，例如 CNY",
      "total": "数字，估算总预算"
    }},
    "highlights": ["数组，列出行程特色主题"]
  }},
  "budget_breakdown": [
    {{
      "category": "transport|accommodation|dining|sightseeing|shopping|other",
      "amount": "数字",
      "description": "字符串说明"
    }}
  ],
  "days": [
    {{
      "title": "字符串，例如 Day 1 - 抵达东京",
      "date": "如已知可填 YYYY-MM-DD，否则 null",
      "summary": "字符串，概述当日亮点",
      "total_budget": "数字，估算当日花费",
      "items": [
        {{
          "time": "时间段或 null，例如 09:00-11:00",
          "name": "POI 名称",
          "type": "scenic|restaurant|hotel|activity|other",
          "address": "详细地址",
          "city": "所在城市/区",
          "description": "活动说明",
          "budget": "数字，单项预算（如无法估算填 null）",
          "notes": "额外提示，可为 null",
          "longitude": "数字，经度，如不确定填 null",
          "latitude": "数字，纬度，如不确定填 null"
        }}
      ],
      "accommodation": {{
        "name": "推荐住宿名称",
        "address": "地址",
        "budget": "数字或 null"
      }},
      "meals": {{
        "breakfast": "早餐建议，可为 null",
        "lunch": "午餐建议",
        "dinner": "晚餐建议"
      }}
    }}
  ],
  "advice": {{
    "preparation": ["行前准备建议"],
    "local_tips": ["当地贴士"],
    "money_saving": ["省钱技巧"],
    "safety": ["安全提示"]
  }},
  "emergency": {{
    "police": "报警电话或链接",
    "medical": "急救电话或医院",
    "embassy": "如适用可提供大使馆联系方式，否则写 null"
  }},
  "itinerary_text": "请提供完整的中文行程文本描述（可多段落），便于纯文本展示"
}}

严格要求：
1. **仅输出 JSON**，不允许出现额外说明或 Markdown。
2. 所有字符串使用双引号；不要包含未转义的换行。
3. 若无具体数字或信息，可使用 null，但保留字段。
4. budget 中金额统一使用人民币 (CNY)，如需要可标注汇率说明。
"""
    
    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7
    )
    content = response.choices[0].message.content.strip()
    # DeepSeek 有时会返回 ```json fenced code block，需提取其中的 JSON 字符串
    if content.startswith("```"):
        # 去掉开头的 ```json 或 ``` 标记
        content = re.sub(r"^```[\w-]*\s*", "", content)
        # 去掉结尾 ``` 标记
        content = re.sub(r"\s*```$", "", content)
    else:
        # 回退：提取第一个 JSON 对象
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            content = match.group(0)
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM returned non-JSON content: {content}") from exc