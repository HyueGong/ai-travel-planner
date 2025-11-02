from openai import OpenAI
import os
from dotenv import load_dotenv

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

def generate_travel_plan(user_input: str) -> str:
    client = get_llm_client()
    
    prompt = f"""
请根据以下用户需求，生成一份详细的中文旅行计划：

用户需求：{user_input}

请按照以下格式用中文回复：

【旅行计划概览】
目的地：
天数：
预算：
人数：
旅行特色：

【预算分配】
总预算：xxx元
- 交通：xxx元（说明）
- 住宿：xxx元（说明）  
- 餐饮：xxx元（说明）
- 景点：xxx元（说明）
- 购物：xxx元
- 其他：xxx元

【每日行程】
第1天：主题
住宿：推荐
餐饮：早餐/午餐/晚餐推荐
行程：
08:00-12:00 活动详情
12:00-14:00 午餐
14:00-18:00 活动详情  
18:00-20:00 晚餐
20:00以后 自由活动
当日费用：xxx元

第2天：主题
[...继续...]

【实用建议】
行前准备：...
当地贴士：...
省钱技巧：...
安全提示：...

【紧急联系】
报警：...
急救：...
大使馆：...

要求：预算合理、行程可行、符合用户偏好、语言亲切自然。
"""
    
    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7
    )
    return response.choices[0].message.content