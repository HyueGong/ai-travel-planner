// frontend/src/App.jsx
import { useState, useRef, useEffect } from 'react';
import Login from './Login.jsx';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // ========== WAV 编码工具函数 ==========
  function createWavBlobFromFloat32(float32Data, sampleRate) {
    const numChannels = 1;
    const format = 1; // PCM
    const bitDepth = 16;

    const output = float32Data;
    const buffer = new ArrayBuffer(44 + output.length * 2);
    const view = new DataView(buffer);

    // WAV 头
    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + output.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, output.length * 2, true);

    // PCM 数据
    const offset = 44;
    for (let i = 0; i < output.length; i++) {
      const s = Math.max(-1, Math.min(1, output[i]));
      view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  // 使用 OfflineAudioContext 做高质量重采样到 16kHz（线性插值由浏览器实现）
  async function resampleTo16kHQ(float32Data, sourceSampleRate) {
    const targetRate = 16000;
    if (sourceSampleRate === targetRate) return float32Data;
    const lengthInSeconds = float32Data.length / sourceSampleRate;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(lengthInSeconds * targetRate), targetRate);
    const buffer = offlineCtx.createBuffer(1, float32Data.length, sourceSampleRate);
    buffer.copyToChannel(float32Data, 0);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0).slice();
  }

  // 简单归一化到 -3dBFS 左右
  function normalizeAudio(float32Data) {
    let max = 0;
    for (let i = 0; i < float32Data.length; i++) {
      const v = Math.abs(float32Data[i]);
      if (v > max) max = v;
    }
    if (max < 1e-6) return float32Data;
    const targetPeak = 0.7071; // -3dBFS ≈ 0.7071
    const gain = targetPeak / max;
    const out = new Float32Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) out[i] = float32Data[i] * gain;
    return out;
  }

  // 裁剪前后静音（简单阈值/最小持续样本）
  function trimSilence(float32Data, sampleRate, threshold = 0.01, minSilenceMs = 150) {
    const minSilenceSamples = Math.floor((minSilenceMs / 1000) * sampleRate);
    let start = 0;
    let end = float32Data.length - 1;
    // 前
    let count = 0;
    for (let i = 0; i < float32Data.length; i++) {
      if (Math.abs(float32Data[i]) < threshold) {
        count++;
      } else {
        if (count >= minSilenceSamples) start = i;
        break;
      }
    }
    // 后
    count = 0;
    for (let i = float32Data.length - 1; i >= 0; i--) {
      if (Math.abs(float32Data[i]) < threshold) {
        count++;
      } else {
        if (count >= minSilenceSamples) end = i;
        break;
      }
    }
    if (end <= start) return float32Data;
    return float32Data.slice(start, end + 1);
  }

  // ========== 录音逻辑 ==========
  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const sampleRate = audioContext.sampleRate; // 实际输入采样率（通常 44100/48000）

    let recordedBuffers = [];

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      recordedBuffers.push(input.slice());
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    setIsRecording(true);

    // 停止逻辑
    const stopRecording = () => {
      processor.disconnect();
      source.disconnect();
      audioContext.close();
      stream.getTracks().forEach(track => track.stop());

      // 合并 buffers
      const totalLength = recordedBuffers.reduce((acc, buf) => acc + buf.length, 0);
      const fullBuffer = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of recordedBuffers) {
        fullBuffer.set(buf, offset);
        offset += buf.length;
      }

      // 处理链：重采样(高质量) → 去静音 → 归一化 → 生成 WAV
      resampleTo16kHQ(fullBuffer, sampleRate).then((resampled) => {
        const trimmed = trimSilence(resampled, 16000);
        const normalized = normalizeAudio(trimmed);
        const wavBlob = createWavBlobFromFloat32(normalized, 16000);
        sendToASR(wavBlob);
      }).catch((e) => {
        console.error('Resample error:', e);
        setTranscript('重采样失败');
      });

      setIsRecording(false);
    };

    mediaRecorderRef.current = { stop: stopRecording };
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
  };

  // ========== 发送到后端 ==========
  const sendToASR = async (blob) => {
    console.log('Sending blob:', { size: blob.size, type: blob.type });
  
    if (blob.size < 100) {
      setTranscript('录音太短或为空');
      return;
    }
  
    const formData = new FormData();
    formData.append('audio', blob, 'speech.wav');
    if (user?.id) formData.append('user_id', user.id);
  
    try {
      const res = await fetch('http://localhost:8000/asr', {
        method: 'POST',
        body: formData,
        // 注意：不要手动设置 Content-Type！浏览器会自动设为 multipart/form-data + boundary
      });
      const data = await res.json();
      const text = data.text || '识别失败';
      setTranscript(text);
      if (user?.id) {
        // 刷新历史
        fetchHistory(user.id);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setTranscript('请求失败');
    }
  };

  const fetchHistory = async (userId) => {
    try {
      const res = await fetch(`http://localhost:8000/history?user_id=${encodeURIComponent(userId)}`);
      const data = await res.json();
      setHistory(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      // 忽略历史加载错误
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem('user');
    if (saved) {
      try {
        const u = JSON.parse(saved);
        setUser(u);
        fetchHistory(u.id);
      } catch {}
    }
  }, []);

  return (
    <div style={{ minHeight: '100vh', width: '100vw', fontFamily: 'sans-serif', background: '#f8fafc' }}>
      {!user ? (
        <Login onAuthed={(u) => { setUser(u); fetchHistory(u.id); }} />
      ) : (
        <>
          {/* 顶部标题与用户信息（标题居中，用户信息在其下方）*/}
          <div style={{ background: '#f8fafc', padding: '20px 20px 12px', width: '100%', borderBottom: '1px solid #e2e8f0' }}>
            <h1 style={{
              textAlign: 'center',
              margin: 0,
              fontSize: 28,
              letterSpacing: 0.5,
              color: '#0f172a'
            }}>
              <span style={{
                background: 'linear-gradient(90deg, #2563eb 0%, #06b6d4 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent'
              }}>AI 旅行规划师</span>
              <span style={{ color: '#64748b', fontWeight: 500 }}> · 语音输入</span>
            </h1>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12 }}>
              <span style={{ color: '#334155', fontSize: 14 }}>{user.email}</span>
              <button
                onClick={() => { localStorage.removeItem('user'); setUser(null); setHistory([]); }}
                style={{
                  padding: '6px 12px',
                  background: '#e5e7eb',
                  color: '#374151',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  cursor: 'pointer'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = '#d1d5db'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#e5e7eb'; }}
              >退出</button>
            </div>
          </div>

          {/* 主体布局：左 1/3 历史，右 2/3 识别区，铺满全宽 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 24, padding: 20, width: '100%' }}>
            {/* 历史区域 */}
            <div style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,0.06)', padding: 16, minHeight: 400 }}>
              <h3 style={{ marginTop: 0, color: '#0f172a' }}>历史记录</h3>
              {history.length === 0 ? (
                <p style={{ color: '#64748b' }}>暂无记录</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {history.map(item => (
                    <li key={item.id} style={{ padding: 10, border: '1px solid #e2e8f0', borderRadius: 8, transition: 'background 0.2s' }}
                        onMouseOver={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                        onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <div>{item.text}</div>
                      {item.created_at && <div style={{ marginTop: 4, color: '#94a3b8', fontSize: 12 }}>{new Date(item.created_at).toLocaleString()}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 识别区域 */}
            <div style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,0.06)', padding: 16, minHeight: 400 }}>
              <h3 style={{ marginTop: 0, color: '#0f172a' }}>语音识别</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={isRecording ? stopRecording : startRecording} style={{ padding: '10px 16px', background: isRecording ? '#ef4444' : '#22c55e', color: '#fff', border: 'none', borderRadius: 8, boxShadow: '0 2px 6px rgba(0,0,0,0.12)' }}>
                  {isRecording ? '停止录音' : '开始录音'}
                </button>
                <span style={{ color: '#64748b' }}>{isRecording ? '录音中...' : '点击开始录音'}</span>
              </div>
              <div style={{ marginTop: 16, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, minHeight: 120, background: '#f8fafc' }}>
                <div style={{ color: '#0f172a' }}>
                  <strong>识别结果：</strong>{transcript}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;