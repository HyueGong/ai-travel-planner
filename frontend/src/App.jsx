// frontend/src/App.jsx
import { useState, useRef, useEffect } from 'react';
import Login from './Login.jsx';
import BudgetPanel from './BudgetPanel.jsx';
import { createWavBlobFromFloat32, resampleTo16kHQ, normalizeAudio, trimSilence } from './audioUtils.js';
import MapView from './MapView.jsx';

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inferPoiType(item) {
  const collectCandidates = () => {
    const candidates = [];
    if (item?.type) candidates.push(item.type);
    if (item?.category) candidates.push(item.category);
    if (Array.isArray(item?.tags)) candidates.push(...item.tags);
    if (item?.name) candidates.push(item.name);
    if (item?.description) candidates.push(item.description);
    return candidates;
  };

  const detectType = (value) => {
    if (value == null) return null;
    const str = String(value).trim();
    if (!str) return null;
    const lower = str.toLowerCase();
    if (
      lower.includes('hotel') ||
      lower.includes('stay') ||
      lower.includes('resort') ||
      lower.includes('accommodation') ||
      str.includes('酒店') ||
      str.includes('旅馆') ||
      str.includes('宾馆') ||
      str.includes('住宿')
    ) {
      return 'hotel';
    }
    if (
      lower.includes('restaurant') ||
      lower.includes('food') ||
      lower.includes('dining') ||
      lower.includes('meal') ||
      lower.includes('cafe') ||
      lower.includes('bar') ||
      str.includes('餐厅') ||
      str.includes('美食') ||
      str.includes('餐饮')
    ) {
      return 'restaurant';
    }
    if (
      lower.includes('scenic') ||
      lower.includes('sight') ||
      lower.includes('attraction') ||
      lower.includes('viewpoint') ||
      lower.includes('landmark') ||
      lower.includes('park') ||
      str.includes('景点') ||
      str.includes('景区') ||
      str.includes('景观') ||
      str.includes('公园') ||
      str.includes('博物馆')
    ) {
      return 'scenic';
    }
    if (
      lower.includes('activity') ||
      lower.includes('event') ||
      lower.includes('experience') ||
      lower.includes('show') ||
      str.includes('活动') ||
      str.includes('演出') ||
      str.includes('体验')
    ) {
      return 'activity';
    }
    return null;
  };

  const candidates = collectCandidates();
  for (const candidate of candidates) {
    const detected = detectType(candidate);
    if (detected) return detected;
  }
  return item?.type || 'other';
}

function flattenPlanPoints(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const points = [];
  plan.days.forEach((day, dayIndex) => {
    const dayTitle = day?.title || `第${dayIndex + 1}天`;
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item, itemIndex) => {
      const longitude = toNumber(item?.longitude);
      const latitude = toNumber(item?.latitude);
      points.push({
        id: `${dayIndex}-${itemIndex}`,
        dayIndex,
        dayTitle,
        time: item?.time || null,
        name: item?.name || '未命名地点',
        type: inferPoiType(item),
        longitude,
        latitude,
        address: item?.address || '',
        city: item?.city || '',
        description: item?.description || '',
        budget: item?.budget ?? null,
      });
    });
  });
  return points;
}

function findFirstCoordinate(plan) {
  const points = flattenPlanPoints(plan);
  return points.find((p) => Number.isFinite(p.longitude) && Number.isFinite(p.latitude)) || null;
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(null); // 当前选中的历史行程
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false); // 是否正在生成行程
  const [currentPlanData, setCurrentPlanData] = useState(null); // 当前生成的结构化行程
  const [currentPlanText, setCurrentPlanText] = useState(''); // 当前生成的文本行程
  const [activePanel, setActivePanel] = useState('plan'); // 'plan' | 'budget'
  const [isDeletingPlanId, setIsDeletingPlanId] = useState(null);
  const [focusedPoiId, setFocusedPoiId] = useState(null);
  const [focusedDayIndex, setFocusedDayIndex] = useState(null);
  const [collapsedDays, setCollapsedDays] = useState({});
  const [textPlanInput, setTextPlanInput] = useState('');

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

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
      setCurrentPlanData(null);
      setCurrentPlanText('');
      setSelectedPlan(null);
      setFocusedPoiId(null);
      setFocusedDayIndex(null);
      setCollapsedDays({});
      
      const res = await fetch('http://localhost:8000/asr_and_plan', {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();
      const text = data.transcript || data.text || '识别失败';
      const planText = data.plan_text || data.plan || '';
      let planStructured = data.plan_structured || null;
      if (planStructured && typeof planStructured === 'string') {
        try {
          planStructured = JSON.parse(planStructured);
        } catch {
          planStructured = null;
        }
      }
      
      setTranscript(text);
      setCurrentPlanText(planText);
      setCurrentPlanData(planStructured);
      setIsGeneratingPlan(false);
      if (planStructured && Array.isArray(planStructured.days)) {
        const defaultFocus = findFirstCoordinate(planStructured);
        setFocusedDayIndex(defaultFocus?.dayIndex ?? null);
        setFocusedPoiId(defaultFocus?.id ?? null);
      }
      
      if (user?.id) {
        // 刷新历史
        fetchHistory(user.id);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setTranscript('请求失败：' + err.message);
      setIsGeneratingPlan(false);
      setCurrentPlanData(null);
      setCurrentPlanText('');
    }
  };

  const fetchHistory = async (userId) => {
    try {
      const res = await fetch(`http://localhost:8000/history?user_id=${encodeURIComponent(userId)}`);
      const data = await res.json();
      if (Array.isArray(data.items)) {
        const normalized = data.items.map((item) => {
          let structured = item.plan_structured;
          if (structured && typeof structured === 'string') {
            try {
              structured = JSON.parse(structured);
            } catch {
              structured = null;
            }
          }
          return { ...item, plan_structured: structured };
        });
        setHistory(normalized);
      } else {
        setHistory([]);
      }
    } catch (e) {
      // 忽略历史加载错误
    }
  };

  const deletePlan = async (planId) => {
    if (!user?.id) return;
    const confirmDelete = window.confirm('确认删除该行程吗？删除后不可恢复。');
    if (!confirmDelete) return;
    setIsDeletingPlanId(planId);
    try {
      const res = await fetch(`http://localhost:8000/travel_plans/${encodeURIComponent(planId)}?user_id=${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || '删除行程失败');
      }
      if (selectedPlan?.id === planId) {
        setSelectedPlan(null);
        setFocusedPoiId(null);
        setFocusedDayIndex(null);
        setCollapsedDays({});
      }
      await fetchHistory(user.id);
    } catch (e) {
      window.alert(e.message || '删除行程失败');
    } finally {
      setIsDeletingPlanId(null);
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

  const activePlanData = currentPlanData || selectedPlan?.plan_structured || null;
  const activePlanText = currentPlanText || selectedPlan?.plan || '';
  const planPoints = flattenPlanPoints(activePlanData);
  const hasStructuredPlan = planPoints.length > 0;
  const hasPlanContent = Boolean(activePlanData || activePlanText);
  const transcriptDisplay = currentPlanData ? transcript : (selectedPlan?.text || transcript);
  const overview = activePlanData?.overview || {};
  const budgetBreakdown = Array.isArray(activePlanData?.budget_breakdown) ? activePlanData.budget_breakdown : [];

  const clearPlanSelection = () => {
    setCurrentPlanData(null);
    setCurrentPlanText('');
    setSelectedPlan(null);
    setFocusedPoiId(null);
    setFocusedDayIndex(null);
    setCollapsedDays({});
  };

  const handleSubmitTextPlan = async () => {
    const input = textPlanInput.trim();
    if (!input) {
      setTranscript('请输入旅行需求文本');
      return;
    }
    setIsGeneratingPlan(true);
    setCurrentPlanData(null);
    setCurrentPlanText('');
    setSelectedPlan(null);
    setFocusedPoiId(null);
    setFocusedDayIndex(null);
    setCollapsedDays({});
    try {
      const res = await fetch('http://localhost:8000/text_plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_input: input,
          user_id: user?.id || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      let planStructured = data.plan_structured || null;
      if (planStructured && typeof planStructured === 'string') {
        try {
          planStructured = JSON.parse(planStructured);
        } catch {
          planStructured = null;
        }
      }
      setTranscript(data.transcript || input);
      setCurrentPlanText(data.plan_text || data.plan || '');
      setCurrentPlanData(planStructured);
      setIsGeneratingPlan(false);
      if (planStructured && Array.isArray(planStructured.days)) {
        const defaultFocus = findFirstCoordinate(planStructured);
        setFocusedDayIndex(defaultFocus?.dayIndex ?? null);
        setFocusedPoiId(defaultFocus?.id ?? null);
      }
      if (user?.id) {
        fetchHistory(user.id);
      }
    } catch (err) {
      console.error('Text plan error:', err);
      setTranscript('请求失败：' + err.message);
      setIsGeneratingPlan(false);
      setCurrentPlanData(null);
      setCurrentPlanText('');
    }
  };

  const handleSelectHistoryItem = (item) => {
    if (!item.plan && !item.plan_structured) return;
    if (selectedPlan?.id === item.id) {
      setSelectedPlan(null);
      setFocusedPoiId(null);
      setFocusedDayIndex(null);
      setCollapsedDays({});
      return;
    }
    setCurrentPlanData(null);
    setCurrentPlanText('');
    setSelectedPlan(item);
    setActivePanel('plan');
    const first = findFirstCoordinate(item.plan_structured);
    setFocusedDayIndex(first?.dayIndex ?? null);
    setFocusedPoiId(first?.id ?? null);
    setCollapsedDays({});
  };

  const handleFocusPoi = (poi) => {
    setFocusedPoiId(poi.id);
    setFocusedDayIndex(poi.dayIndex);
    setCollapsedDays((prev) => ({
      ...prev,
      [poi.dayIndex]: false,
    }));
  };

  const toggleDayCollapse = (dayIndex) => {
    setCollapsedDays((prev) => ({
      ...prev,
      [dayIndex]: !prev[dayIndex],
    }));
  };

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
                onClick={() => { localStorage.removeItem('user'); setUser(null); setHistory([]); setActivePanel('plan'); }}
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
                        cursor: (item.plan || item.plan_structured) ? 'pointer' : 'default',
                        background: selectedPlan?.id === item.id 
                          ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' 
                          : 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                        boxShadow: selectedPlan?.id === item.id 
                          ? '0 4px 12px rgba(59, 130, 246, 0.15)' 
                          : '0 2px 4px rgba(0,0,0,0.04)'
                      }}
                      onClick={() => handleSelectHistoryItem(item)}
                      onMouseOver={(e) => { 
                        if ((item.plan || item.plan_structured) && selectedPlan?.id !== item.id) {
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
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
                          {(item.plan || item.plan_structured) && (
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
                        </div>
                        {(item.plan || item.plan_structured) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); deletePlan(item.id); }}
                            disabled={isDeletingPlanId === item.id}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 6,
                              border: '1px solid #fca5a5',
                              background: isDeletingPlanId === item.id ? '#fecaca' : '#fee2e2',
                              color: '#b91c1c',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: isDeletingPlanId === item.id ? 'not-allowed' : 'pointer',
                              minWidth: 70,
                              transition: 'background 0.2s, transform 0.2s'
                            }}
                            onMouseOver={(e) => {
                              if (isDeletingPlanId === item.id) return;
                              e.currentTarget.style.background = '#fca5a5';
                              e.currentTarget.style.transform = 'translateY(-1px)';
                            }}
                            onMouseOut={(e) => {
                              e.currentTarget.style.background = isDeletingPlanId === item.id ? '#fecaca' : '#fee2e2';
                              e.currentTarget.style.transform = 'translateY(0)';
                            }}
                          >
                            {isDeletingPlanId === item.id ? '删除中…' : '删除'}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 识别区域 / 预算管理区域 */}
            <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 24, minHeight: 500, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                  <h3 style={{ margin: 0, color: '#0f172a', fontSize: 24, fontWeight: 600 }}>
                    {activePanel === 'plan' ? '✈️ 旅行行程' : '💰 预算管理'}
                  </h3>
                  <div style={{ marginTop: 4, fontSize: 13, color: '#64748b' }}>
                    {activePanel === 'plan'
                      ? (currentPlanData ? '刚刚生成的行程' : selectedPlan ? '历史行程' : '语音 / 文本输入计划')
                      : '实时查看预算、记录开销'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 4, borderRadius: 8 }}>
                    <button
                      onClick={() => setActivePanel('plan')}
                      style={{
                        padding: '6px 12px',
                        background: activePanel === 'plan' ? '#3b82f6' : 'transparent',
                        color: activePanel === 'plan' ? '#fff' : '#64748b',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 500,
                        transition: 'all 0.2s'
                      }}
                    >
                      行程
                    </button>
                    <button
                      onClick={() => setActivePanel('budget')}
                      style={{
                        padding: '6px 12px',
                        background: activePanel === 'budget' ? '#3b82f6' : 'transparent',
                        color: activePanel === 'budget' ? '#fff' : '#64748b',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 500,
                        transition: 'all 0.2s'
                      }}
                    >
                      预算
                    </button>
                  </div>
                  {activePanel === 'plan' && hasPlanContent && (
                    <button 
                      onClick={clearPlanSelection}
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
                  )}
                </div>
              </div>

              {activePanel === 'plan' ? (
                <>
                  <div style={{ marginBottom: 20, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <textarea
                      value={textPlanInput}
                      onChange={(e) => setTextPlanInput(e.target.value)}
                      placeholder="请输入旅行需求，例如：想在8月份带父母去成都玩5天，预算8000元，想吃火锅、看大熊猫。"
                      style={{
                        flex: '1 1 420px',
                        minHeight: 110,
                        padding: 14,
                        borderRadius: 12,
                        border: '1px solid #e2e8f0',
                        background: '#f8fafc',
                        fontSize: 14,
                        lineHeight: 1.6,
                        color: '#0f172a',
                        boxShadow: 'inset 0 2px 4px rgba(15,23,42,0.04)',
                        resize: 'vertical',
                      }}
                      disabled={isGeneratingPlan}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 180 }}>
                      <button
                        onClick={handleSubmitTextPlan}
                        disabled={isGeneratingPlan}
                        style={{
                          padding: '12px 18px',
                          background: isGeneratingPlan
                            ? 'linear-gradient(135deg, #cbd5f5 0%, #bfdbfe 100%)'
                            : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 10,
                          cursor: isGeneratingPlan ? 'not-allowed' : 'pointer',
                          fontSize: 14,
                          fontWeight: 600,
                          boxShadow: isGeneratingPlan ? 'none' : '0 6px 16px rgba(37, 99, 235, 0.25)',
                          transition: 'transform 0.2s, box-shadow 0.2s',
                          minHeight: 52,
                        }}
                        onMouseOver={(e) => {
                          if (isGeneratingPlan) return;
                          e.currentTarget.style.transform = 'translateY(-2px)';
                          e.currentTarget.style.boxShadow = '0 8px 20px rgba(37, 99, 235, 0.3)';
                        }}
                        onMouseOut={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = isGeneratingPlan ? 'none' : '0 6px 16px rgba(37, 99, 235, 0.25)';
                        }}
                      >
                        {isGeneratingPlan ? '⏳ 正在生成…' : '🧭 文本生成行程'}
                      </button>
                      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                        支持自然语言描述需求，自动生成行程，并与地图联动定位。
                      </div>
                    </div>
                  </div>
                  {hasPlanContent ? (
                    hasStructuredPlan ? (
                      <>
                        <div style={{ 
                          padding: 16, 
                          background: 'linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%)',
                          borderRadius: 12,
                          border: '1px solid #e2e8f0'
                        }}>
                          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            语音 / 文本输入
                          </div>
                          <div style={{ color: '#0f172a', fontWeight: 500, fontSize: 15, lineHeight: 1.6 }}>
                            {transcriptDisplay || '暂无识别内容'}
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 35%) minmax(0, 65%)', gap: 20, flex: 1 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
                            <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', boxShadow: '0 2px 6px rgba(15,23,42,0.04)' }}>
                              <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 16, marginBottom: 8 }}>行程概览</div>
                              <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {overview.destination && <span>目的地：{overview.destination}</span>}
                                {overview.days && <span>天数：{overview.days}</span>}
                                {overview.travelers && <span>同行：{overview.travelers}</span>}
                                {overview.budget?.total != null && (
                                  <span>预算：{overview.budget.currency || 'CNY'} {overview.budget.total}</span>
                                )}
                                {Array.isArray(overview.highlights) && overview.highlights.length > 0 && (
                                  <span>亮点：{overview.highlights.join('、')}</span>
                                )}
                              </div>
                            </div>
                            {budgetBreakdown.length > 0 && (
                              <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#ffffff', boxShadow: '0 2px 6px rgba(15,23,42,0.04)' }}>
                                <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 14, marginBottom: 8 }}>预算分配</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#475569' }}>
                                  {budgetBreakdown.map((bucket, idx) => (
                                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                      <span>{bucket.category || '其他'}</span>
                                      <span>{bucket.amount != null ? bucket.amount : '待定'}{bucket.description ? `（${bucket.description}）` : ''}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
                              {(activePlanData?.days || []).map((day, dayIndex) => {
                                const dayTitle = day?.title || `第${dayIndex + 1}天`;
                                const dayItems = planPoints.filter((p) => p.dayIndex === dayIndex);
                                const isFocusedDay = focusedDayIndex === dayIndex;
                                const accommodation = day?.accommodation || {};
                                const meals = day?.meals || {};
                                const isCollapsed = !!collapsedDays[dayIndex];
                                return (
                                  <div
                                    key={dayIndex}
                                    style={{
                                      border: isFocusedDay ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                                      borderRadius: 12,
                                      padding: 16,
                                      background: isFocusedDay ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff',
                                      boxShadow: isFocusedDay ? '0 4px 12px rgba(59,130,246,0.12)' : '0 2px 6px rgba(15,23,42,0.04)',
                                      transition: 'all 0.2s'
                                    }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <button
                                          onClick={() => toggleDayCollapse(dayIndex)}
                                          style={{
                                            border: 'none',
                                            background: 'transparent',
                                            color: '#3b82f6',
                                            cursor: 'pointer',
                                            fontSize: 12,
                                            fontWeight: 600,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            padding: '4px 6px',
                                            borderRadius: 6,
                                          }}
                                          onMouseOver={(e) => {
                                            e.currentTarget.style.background = 'rgba(59,130,246,0.12)';
                                          }}
                                          onMouseOut={(e) => {
                                            e.currentTarget.style.background = 'transparent';
                                          }}
                                        >
                                          <span>{isCollapsed ? '▶' : '▼'}</span>
                                          <span>{dayTitle}</span>
                                        </button>
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        {day.total_budget != null && (
                                          <div style={{ fontSize: 12, color: '#0f766e' }}>当日花费：{day.total_budget}</div>
                                        )}
                                      </div>
                                    </div>
                                    {!isCollapsed && (
                                      <>
                                        {day.summary && (
                                          <div style={{ fontSize: 12, color: '#475569', marginBottom: 8, lineHeight: 1.6 }}>
                                            {day.summary}
                                          </div>
                                        )}
                                        {accommodation.name && (
                                          <div style={{ fontSize: 12, color: '#1e40af', marginBottom: 6 }}>
                                            住宿：{accommodation.name}{accommodation.budget != null ? `（预算 ${accommodation.budget}）` : ''}
                                          </div>
                                        )}
                                        <div style={{ fontSize: 12, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                                          {meals.breakfast && <span>早餐：{meals.breakfast}</span>}
                                          {meals.lunch && <span>午餐：{meals.lunch}</span>}
                                          {meals.dinner && <span>晚餐：{meals.dinner}</span>}
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                          {dayItems.map((point) => {
                                            const isFocused = focusedPoiId === point.id;
                                            return (
                                              <button
                                                key={point.id}
                                                onClick={() => handleFocusPoi(point)}
                                                style={{
                                                  textAlign: 'left',
                                                  padding: 12,
                                                  background: isFocused ? 'rgba(59,130,246,0.12)' : '#f8fafc',
                                                  border: isFocused ? '1px solid rgba(59,130,246,0.4)' : '1px solid #e2e8f0',
                                                  borderRadius: 10,
                                                  cursor: 'pointer',
                                                  display: 'flex',
                                                  flexDirection: 'column',
                                                  gap: 4,
                                                  transition: 'background 0.2s, transform 0.2s',
                                                  color: '#0f172a',
                                                  fontSize: 13
                                                }}
                                                onMouseOver={(e) => {
                                                  e.currentTarget.style.background = 'rgba(59,130,246,0.18)';
                                                }}
                                                onMouseOut={(e) => {
                                                  e.currentTarget.style.background = isFocused ? 'rgba(59,130,246,0.12)' : '#f8fafc';
                                                }}
                                              >
                                                <span style={{ fontWeight: 600 }}>
                                                  {point.time ? `${point.time} · ${point.name}` : point.name}
                                                </span>
                                                {point.description && (
                                                  <span style={{ color: '#475569', lineHeight: 1.6 }}>{point.description}</span>
                                                )}
                                                {point.address && (
                                                  <span style={{ color: '#94a3b8' }}>{point.address}</span>
                                                )}
                                                {point.budget != null && (
                                                  <span style={{ color: '#0f766e', fontSize: 12 }}>
                                                    预算：{point.budget}
                                                  </span>
                                                )}
                                              </button>
                                            );
                                          })}
                                          {dayItems.length === 0 && (
                                            <div style={{ fontSize: 12, color: '#94a3b8' }}>当前日期暂无可定位的行程节点</div>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          <div style={{ minHeight: 520, height: '100%' }}>
                            <MapView
                              points={planPoints}
                              focusPointId={focusedPoiId}
                              onMarkerClick={handleFocusPoi}
                            />
                          </div>
                        </div>
                        {activePlanText && (
                          <div style={{ 
                            padding: 20, 
                            border: '2px solid #e2e8f0', 
                            borderRadius: 12, 
                            background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                            maxHeight: 320,
                            overflowY: 'auto',
                            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.04)'
                          }}>
                            <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 10 }}>文本行程</div>
                            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, color: '#1e293b', fontSize: 14 }}>
                              {activePlanText}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div style={{ 
                          marginBottom: 16, 
                          padding: 16, 
                          background: 'linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%)',
                          borderRadius: 12,
                          border: '1px solid #e2e8f0'
                        }}>
                          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            语音 / 文本输入
                          </div>
                          <div style={{ color: '#0f172a', fontWeight: 500, fontSize: 15, lineHeight: 1.6 }}>
                            {transcriptDisplay || '暂无识别内容'}
                          </div>
                        </div>
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
                            {activePlanText || '暂无行程内容'}
                          </div>
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <h3 style={{ marginTop: 0, marginBottom: 24, color: '#0f172a', fontSize: 24, fontWeight: 600 }}>
                        🎙️ 语音识别
                      </h3>
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
                          disabled={isGeneratingPlan}
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
                            cursor: isRecording || isGeneratingPlan ? 'not-allowed' : 'pointer',
                            transition: 'transform 0.2s, box-shadow 0.2s',
                            minWidth: 140,
                            opacity: isGeneratingPlan && !isRecording ? 0.7 : 1,
                          }}
                          onMouseOver={(e) => { 
                            if (!isRecording && !isGeneratingPlan) {
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
                </>
              ) : (
                <BudgetPanel user={user} history={history} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;