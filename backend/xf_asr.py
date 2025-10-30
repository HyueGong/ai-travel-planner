# backend/xf_asr.py (WebSocket 版)
import websocket
import base64
import hmac
import hashlib
import time
import json
import threading
from urllib.parse import urlencode
from datetime import datetime
import os
from dotenv import load_dotenv
from pathlib import Path
import io
import wave
from array import array

# 明确从 backend/.env 读取
load_dotenv(dotenv_path=str(Path(__file__).with_name('.env')))

APPID = os.getenv("XF_APPID")
API_KEY = os.getenv("XF_API_KEY")
API_SECRET = os.getenv("XF_API_SECRET")

def create_url():
    host = "iat-api.xfyun.cn"
    url = f"wss://{host}/v2/iat"
    # 生成鉴权参数
    date = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S GMT")
    signature_origin = f"host: {host}\ndate: {date}\nGET /v2/iat HTTP/1.1"
    signature_sha = hmac.new(
        API_SECRET.encode("utf-8"),
        signature_origin.encode("utf-8"),
        digestmod=hashlib.sha256
    ).digest()
    signature = base64.b64encode(signature_sha).decode("utf-8")
    authorization_origin = (
        f'api_key="{API_KEY}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    params = {"host": host, "date": date, "authorization": authorization}
    return url + "?" + urlencode(params)

def _wav_to_mono16k_pcm(audio_bytes: bytes) -> bytes:
    """将任意 WAV 字节流转换为 单声道/16kHz/16-bit PCM 原始帧（小端）"""
    with wave.open(io.BytesIO(audio_bytes), 'rb') as wav:
        nch = wav.getnchannels()
        sampwidth = wav.getsampwidth()
        sr = wav.getframerate()
        nframes = wav.getnframes()
        frames = wav.readframes(nframes)

    # 仅支持 16-bit 输入，其他位深可扩展
    if sampwidth != 2:
        raise ValueError(f"Unsupported sample width: {sampwidth * 8} bits; expected 16-bit PCM")

    # 转为 int16 数组
    samples = array('h')
    samples.frombytes(frames)

    # 下混为单声道
    if nch == 2:
        left = samples[0::2]
        right = samples[1::2]
        mono = array('h', ((l + r) // 2 for l, r in zip(left, right)))
    elif nch == 1:
        mono = samples
    else:
        raise ValueError(f"Unsupported channels: {nch}")

    # 采样率转换到 16000（简单线性插值）
    target_sr = 16000
    if sr == target_sr:
        out = mono
    else:
        ratio = target_sr / sr
        new_len = int(len(mono) * ratio)
        if new_len <= 0:
            return b""
        out = array('h')
        for i in range(new_len):
            # 源位置
            src_pos = i / ratio
            j = int(src_pos)
            if j + 1 < len(mono):
                frac = src_pos - j
                val = int(mono[j] * (1 - frac) + mono[j + 1] * frac)
            else:
                val = int(mono[-1])
            # 裁剪到 int16
            if val > 32767:
                val = 32767
            if val < -32768:
                val = -32768
            out.append(val)

    return out.tobytes()


def transcribe_audio_bytes(audio_bytes: bytes) -> str:
    # 使用基于 sn 的聚合，严格按讯飞 wpgs 规则替换，避免首字重复
    result_by_sn: dict[int, str] = {}
    error_holder = {"error": None}
    finished = threading.Event()
    # 将前端上传的 WAV 转原始 PCM（16k 单声道 16-bit）
    pcm_bytes = _wav_to_mono16k_pcm(audio_bytes)

    def on_message(ws, message):
        data = json.loads(message)
        code = data.get("code")
        if code == 0:
            data_field = data.get("data", {})
            status_field = data_field.get("status")  # 0/1 增量，2 结束
            res = data_field.get("result")
            if res and "ws" in res:
                # 本次片段文本
                piece = "".join(ws_item["cw"][0]["w"] for ws_item in res["ws"])
                sn = res.get("sn")  # 序号（从 0 递增）
                pgs = res.get("pgs")  # 'apd' 或 'rpl' 或 None
                rg = res.get("rg")   # [start, end] 当 pgs == 'rpl'

                # 替换模式：清理区间并写入当前 sn 的文本
                if pgs == "rpl" and isinstance(rg, list) and len(rg) == 2:
                    start, end = int(rg[0]), int(rg[1])
                    if end < start:
                        end = start
                    for k in range(start, end + 1):
                        if k in result_by_sn:
                            del result_by_sn[k]
                    if isinstance(sn, int):
                        result_by_sn[sn] = piece
                else:
                    # 追加模式：直接覆盖/写入当前 sn
                    if isinstance(sn, int):
                        result_by_sn[sn] = piece

            # 最终包：结束等待
            if status_field == 2:
                finished.set()
        else:
            error_holder["error"] = data

    def on_error(ws, error):
        error_holder["error"] = {"ws_error": str(error)}
        finished.set()

    def on_close(ws, close_status_code, close_msg):
        finished.set()

    def on_open(ws):
        def sender():
            # 分片：640 字节 ≈ 20ms（16kHz * 16bit * 1ch）
            chunk_size = 640
            total = len(pcm_bytes)
            sent = 0
            # 首帧（包含业务参数，建议增加 vad_eos）
            first_chunk = pcm_bytes[:chunk_size]
            frame0 = {
                "common": {"app_id": APPID},
                "business": {
                    "language": "zh_cn",
                    "domain": "iat",
                    "accent": "mandarin",
                    "vad_eos": 2000,
                    "ptt": 1,
                    "dwa": "wpgs"
                },
                "data": {
                    "status": 0,
                    "format": "audio/L16;rate=16000",
                    "encoding": "raw",
                    "audio": base64.b64encode(first_chunk).decode("utf-8"),
                },
            }
            ws.send(json.dumps(frame0))
            sent += len(first_chunk)
            time.sleep(0.02)

            # 中间帧
            while sent + chunk_size < total:
                chunk = pcm_bytes[sent:sent + chunk_size]
                frame = {
                    "data": {
                        "status": 1,
                        "format": "audio/L16;rate=16000",
                        "encoding": "raw",
                        "audio": base64.b64encode(chunk).decode("utf-8"),
                    }
                }
                ws.send(json.dumps(frame))
                sent += len(chunk)
                time.sleep(0.02)

            # 尾帧（可能还有余量一起发完）
            if sent < total:
                last_chunk = pcm_bytes[sent:]
                frame_last = {
                    "data": {
                        "status": 2,
                        "format": "audio/L16;rate=16000",
                        "encoding": "raw",
                        "audio": base64.b64encode(last_chunk).decode("utf-8"),
                    }
                }
                ws.send(json.dumps(frame_last))
            else:
                ws.send(json.dumps({"data": {"status": 2}}))

        threading.Thread(target=sender, daemon=True).start()

    url = create_url()
    ws = websocket.WebSocketApp(
        url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    # 运行并等待完成或超时（例如 15 秒）
    t = threading.Thread(target=lambda: ws.run_forever(ping_interval=8, ping_timeout=4))
    t.daemon = True
    t.start()
    finished.wait(timeout=60)
    try:
        ws.close()
    except Exception:
        pass

    # 按 sn 排序合并，避免重复与错位
    if result_by_sn:
        ordered = [result_by_sn[k] for k in sorted(result_by_sn.keys())]
        final_text = "".join(ordered)
    else:
        final_text = ""
    if error_holder["error"] or not final_text:
        # 简单重试一次
        if not getattr(transcribe_audio_bytes, "_retried", False):
            setattr(transcribe_audio_bytes, "_retried", True)
            try:
                return transcribe_audio_bytes(audio_bytes)
            finally:
                setattr(transcribe_audio_bytes, "_retried", False)
        if error_holder["error"]:
            raise Exception(f"ASR WS error: {error_holder['error']}")
    return final_text