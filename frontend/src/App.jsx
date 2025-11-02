// frontend/src/App.jsx
import { useState, useRef, useEffect } from 'react';
import Login from './Login.jsx';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(null); // 当前选中的行程
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false); // 是否正在生成行程
  const [currentPlan, setCurrentPlan] = useState(null); // 当前生成的行程（还未保存）

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
      // 先显示识别中状态
      setTranscript('正在识别语音...');
      setIsGeneratingPlan(true);
      setCurrentPlan(null);
      
      const res = await fetch('http://localhost:8000/asr_and_plan', {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();
      const text = data.transcript || data.text || '识别失败';
      const plan = data.plan || null;
      
      setTranscript(text);
      setCurrentPlan(plan);
      setIsGeneratingPlan(false);
      
      if (user?.id) {
        // 刷新历史
        fetchHistory(user.id);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setTranscript('请求失败：' + err.message);
      setIsGeneratingPlan(false);
      setCurrentPlan(null);
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
            <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 24, minHeight: 500 }}>
              <h3 style={{ marginTop: 0, marginBottom: 20, color: '#0f172a', fontSize: 20, fontWeight: 600 }}>
                📚 历史记录
              </h3>
              {history.length === 0 ? (
                <div style={{ 
                  textAlign: 'center', 
                  padding: '60px 20px',
                  color: '#94a3b8',
                  fontSize: 14
                }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
                  <div>暂无历史记录</div>
                  <div style={{ fontSize: 12, marginTop: 8, color: '#cbd5e1' }}>开始录音生成你的第一个行程吧！</div>
                </div>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {history.map(item => (
                    <li 
                      key={item.id} 
                      style={{ 
                        padding: 16, 
                        border: selectedPlan?.id === item.id ? '2px solid #3b82f6' : '2px solid #e2e8f0', 
                        borderRadius: 12, 
                        transition: 'all 0.2s',
                        cursor: item.plan ? 'pointer' : 'default',
                        background: selectedPlan?.id === item.id 
                          ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' 
                          : 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                        boxShadow: selectedPlan?.id === item.id 
                          ? '0 4px 12px rgba(59, 130, 246, 0.15)' 
                          : '0 2px 4px rgba(0,0,0,0.04)'
                      }}
                      onClick={() => {
                        if (item.plan) {
                          setCurrentPlan(null); // 清除当前生成的行程
                          setSelectedPlan(selectedPlan?.id === item.id ? null : item);
                        }
                      }}
                      onMouseOver={(e) => { 
                        if (item.plan && selectedPlan?.id !== item.id) {
                          e.currentTarget.style.border = '2px solid #93c5fd';
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(147, 197, 253, 0.2)';
                          e.currentTarget.style.transform = 'translateY(-2px)';
                        }
                      }}
                      onMouseOut={(e) => { 
                        if (selectedPlan?.id !== item.id) {
                          e.currentTarget.style.border = '2px solid #e2e8f0';
                          e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.04)';
                          e.currentTarget.style.transform = 'translateY(0)';
                        }
                      }}>
                      <div style={{ 
                        fontWeight: selectedPlan?.id === item.id ? 600 : 500,
                        color: '#0f172a',
                        fontSize: 14,
                        lineHeight: 1.6,
                        marginBottom: 8,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}>
                        {item.text || '无文本'}
                      </div>
                      {item.created_at && (
                        <div style={{ 
                          marginTop: 8, 
                          color: '#94a3b8', 
                          fontSize: 11,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4
                        }}>
                          <span>🕒</span>
                          <span>{new Date(item.created_at).toLocaleString('zh-CN', { 
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}</span>
                        </div>
                      )}
                      {item.plan && (
                        <div style={{ 
                          marginTop: 10, 
                          padding: '6px 12px',
                          background: selectedPlan?.id === item.id 
                            ? 'rgba(59, 130, 246, 0.2)' 
                            : 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)',
                          borderRadius: 6,
                          fontSize: 11, 
                          color: '#1e40af',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}>
                          {selectedPlan?.id === item.id ? '✓ 已展开' : '👆 点击查看行程'}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 识别区域/行程显示区域 */}
            <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 24, minHeight: 500, display: 'flex', flexDirection: 'column' }}>
              {/* 优先显示当前生成的行程，其次是历史记录中选中的行程 */}
              {(currentPlan || selectedPlan) ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                    <div>
                      <h3 style={{ margin: 0, color: '#0f172a', fontSize: 24, fontWeight: 600 }}>
                        ✈️ 旅行行程
                      </h3>
                      <div style={{ marginTop: 4, fontSize: 13, color: '#64748b' }}>
                        {currentPlan ? '刚刚生成的行程' : '历史行程'}
                      </div>
                    </div>
                    <button 
                      onClick={() => { setCurrentPlan(null); setSelectedPlan(null); }}
                      style={{
                        padding: '8px 16px',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 8,
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 500,
                        boxShadow: '0 2px 8px rgba(102, 126, 234, 0.3)',
                        transition: 'transform 0.2s, box-shadow 0.2s'
                      }}
                      onMouseOver={(e) => { 
                        e.currentTarget.style.transform = 'translateY(-1px)';
                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.4)';
                      }}
                      onMouseOut={(e) => { 
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.3)';
                      }}
                    >
                      返回识别
                    </button>
                  </div>
                  
                  {/* 语音输入内容卡片 */}
                  <div style={{ 
                    marginBottom: 16, 
                    padding: 16, 
                    background: 'linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%)',
                    borderRadius: 12,
                    border: '1px solid #e2e8f0'
                  }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      🎤 语音输入
                    </div>
                    <div style={{ color: '#0f172a', fontWeight: 500, fontSize: 15, lineHeight: 1.6 }}>
                      {currentPlan ? transcript : (selectedPlan?.text || '')}
                    </div>
                  </div>
                  
                  {/* 行程内容卡片 */}
                  <div style={{ 
                    flex: 1,
                    padding: 20, 
                    border: '2px solid #e2e8f0', 
                    borderRadius: 12, 
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                    maxHeight: 'calc(70vh - 200px)',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.04)'
                  }}>
                    <div style={{
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.8,
                      color: '#1e293b',
                      fontSize: 14,
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
                    }}>
                      {currentPlan || selectedPlan?.plan || '暂无行程内容'}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h3 style={{ marginTop: 0, marginBottom: 24, color: '#0f172a', fontSize: 24, fontWeight: 600 }}>
                    🎙️ 语音识别
                  </h3>
                  
                  {/* 录音按钮区域 */}
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 16, 
                    marginBottom: 24,
                    padding: 20,
                    background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
                    borderRadius: 12,
                    border: '2px dashed #cbd5e1'
                  }}>
                    <button 
                      onClick={isRecording ? stopRecording : startRecording} 
                      style={{ 
                        padding: '14px 28px', 
                        background: isRecording 
                          ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' 
                          : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                        color: '#fff', 
                        border: 'none', 
                        borderRadius: 12, 
                        boxShadow: isRecording 
                          ? '0 4px 12px rgba(239, 68, 68, 0.4)' 
                          : '0 4px 12px rgba(34, 197, 94, 0.4)',
                        fontSize: 16,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'transform 0.2s, box-shadow 0.2s',
                        minWidth: 140
                      }}
                      onMouseOver={(e) => { 
                        if (!isRecording) {
                          e.currentTarget.style.transform = 'translateY(-2px)';
                          e.currentTarget.style.boxShadow = '0 6px 16px rgba(34, 197, 94, 0.5)';
                        }
                      }}
                      onMouseOut={(e) => { 
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = isRecording 
                          ? '0 4px 12px rgba(239, 68, 68, 0.4)' 
                          : '0 4px 12px rgba(34, 197, 94, 0.4)';
                      }}
                    >
                      {isRecording ? '⏹️ 停止录音' : '🎙️ 开始录音'}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: '#0f172a', fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
                        {isRecording ? '🔴 正在录音...' : isGeneratingPlan ? '⏳ 正在处理...' : '👆 点击开始录音'}
                      </div>
                      {isRecording && (
                        <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
                          录音中，请说话...
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* 识别结果卡片 */}
                  <div style={{ 
                    marginTop: 'auto',
                    padding: 20, 
                    border: '2px solid #e2e8f0', 
                    borderRadius: 12, 
                    minHeight: 150, 
                    background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.04)'
                  }}>
                    <div style={{ 
                      fontSize: 13, 
                      color: '#64748b', 
                      marginBottom: 12, 
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5
                    }}>
                      📝 识别结果
                    </div>
                    <div style={{ 
                      color: '#0f172a', 
                      fontSize: 15,
                      lineHeight: 1.8,
                      minHeight: 60,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}>
                      {isGeneratingPlan ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#3b82f6' }}>
                          <div style={{
                            width: 20,
                            height: 20,
                            border: '3px solid #dbeafe',
                            borderTop: '3px solid #3b82f6',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                          }}></div>
                          <span>正在识别并生成行程，请稍候...</span>
                        </div>
                      ) : transcript ? (
                        transcript
                      ) : (
                        <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>暂无识别结果，请开始录音</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;