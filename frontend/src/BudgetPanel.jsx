// frontend/src/BudgetPanel.jsx
import { useEffect, useRef, useState } from 'react';
import { createWavBlobFromFloat32, resampleTo16kHQ, normalizeAudio, trimSilence } from './audioUtils.js';

const categoryOptions = [
  { value: 'food', label: '餐饮' },
  { value: 'transport', label: '交通' },
  { value: 'hotel', label: '住宿' },
  { value: 'entertainment', label: '娱乐' },
  { value: 'shopping', label: '购物' },
  { value: 'other', label: '其他' },
];

function BudgetPanel({ user, history = [] }) {
  const [budgets, setBudgets] = useState([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);
  const [budgetSummary, setBudgetSummary] = useState(null);
  const [isLoadingBudgets, setIsLoadingBudgets] = useState(false);
  const [isLoadingExpenses, setIsLoadingExpenses] = useState(false);
  const [error, setError] = useState('');
  const [budgetForm, setBudgetForm] = useState({
    totalBudget: '',
    currency: 'CNY',
    notes: '',
    planId: '',
  });
  const [expenseForm, setExpenseForm] = useState({
    amount: '',
    currency: 'CNY',
    category: 'food',
    description: '',
  });
  const [isCreatingBudget, setIsCreatingBudget] = useState(false);
  const [isAddingExpense, setIsAddingExpense] = useState(false);
  const [isRecordingExpense, setIsRecordingExpense] = useState(false);
  const [expenseStatus, setExpenseStatus] = useState('');
  const [expenseError, setExpenseError] = useState('');
  const [deletingBudgetId, setDeletingBudgetId] = useState(null);

  const expenseRecorderRef = useRef(null);
  const expenseAudioBuffersRef = useRef([]);
  const expenseSampleRateRef = useRef(null);

  const normalizedHistory = Array.isArray(history) ? history : [];

  useEffect(() => {
    if (!user?.id) {
      setBudgets([]);
      setSelectedBudgetId(null);
      setBudgetSummary(null);
      return;
    }
    fetchBudgets(user.id);
  }, [user?.id]);

  useEffect(() => {
    if (!selectedBudgetId || !user?.id) return;
    fetchBudgetDetails(selectedBudgetId, user.id);
  }, [selectedBudgetId, user?.id]);

  const fetchBudgets = async (userId) => {
    setIsLoadingBudgets(true);
    setError('');
    try {
      const res = await fetch(`http://localhost:8000/budgets?user_id=${encodeURIComponent(userId)}`);
      if (!res.ok) {
        throw new Error(`获取预算失败，状态码 ${res.status}`);
      }
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setBudgets(items);
      if (items.length > 0) {
        setSelectedBudgetId(items[0].id);
      } else {
        setSelectedBudgetId(null);
        setBudgetSummary(null);
      }
    } catch (e) {
      setError(e.message || '获取预算失败');
    } finally {
      setIsLoadingBudgets(false);
    }
  };

  const fetchBudgetDetails = async (budgetId, userId) => {
    setIsLoadingExpenses(true);
    setExpenseStatus('');
    setExpenseError('');
    try {
      const res = await fetch(
        `http://localhost:8000/expenses?user_id=${encodeURIComponent(userId)}&budget_id=${encodeURIComponent(budgetId)}`
      );
      if (!res.ok) {
        throw new Error(`获取开销失败，状态码 ${res.status}`);
      }
      const data = await res.json();
      setBudgetSummary(data);
    } catch (e) {
      setExpenseError(e.message || '获取开销失败');
    } finally {
      setIsLoadingExpenses(false);
    }
  };

  const handleBudgetInputChange = (field, value) => {
    setBudgetForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleExpenseInputChange = (field, value) => {
    setExpenseForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleCreateBudget = async (e) => {
    e.preventDefault();
    setExpenseStatus('');
    setExpenseError('');
    if (!user?.id) return;
    const amount = parseFloat(budgetForm.totalBudget);
    if (Number.isNaN(amount) || amount <= 0) {
      setError('请输入有效的预算金额');
      return;
    }
    setIsCreatingBudget(true);
    setError('');
    try {
      const payload = {
        user_id: user.id,
        total_budget: amount,
        currency: budgetForm.currency || 'CNY',
        notes: budgetForm.notes || null,
        plan_id: budgetForm.planId ? Number(budgetForm.planId) : null,
      };
      const res = await fetch('http://localhost:8000/budgets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || '创建预算失败');
      }
      await fetchBudgets(user.id);
      setBudgetForm({
        totalBudget: '',
        currency: budgetForm.currency,
        notes: '',
        planId: '',
      });
    } catch (e) {
      setError(e.message || '创建预算失败');
    } finally {
      setIsCreatingBudget(false);
    }
  };

  const handleAddExpense = async (e) => {
    e.preventDefault();
    if (!selectedBudgetId || !user?.id) {
      setExpenseError('请先选择一个预算');
      return;
    }
    const amount = parseFloat(expenseForm.amount);
    if (Number.isNaN(amount) || amount < 0) {
      setExpenseError('请输入有效的金额');
      return;
    }
    setIsAddingExpense(true);
    setExpenseError('');
    setExpenseStatus('');
    try {
      const payload = {
        user_id: user.id,
        budget_id: selectedBudgetId,
        category: expenseForm.category,
        amount,
        currency: expenseForm.currency || 'CNY',
        description: expenseForm.description || '',
        source: 'text',
      };
      const res = await fetch('http://localhost:8000/expenses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || '添加开销失败');
      }
      setExpenseForm((prev) => ({
        ...prev,
        amount: '',
        description: '',
      }));
      setExpenseStatus('开销记录已添加');
      await fetchBudgetDetails(selectedBudgetId, user.id);
    } catch (e) {
      setExpenseError(e.message || '添加开销失败');
    } finally {
      setIsAddingExpense(false);
    }
  };

  const handleDeleteBudget = async (budgetId) => {
    if (!user?.id) return;
    const confirmDelete = window.confirm('确认删除该预算吗？关联的开销记录也会被删除。');
    if (!confirmDelete) return;
    setDeletingBudgetId(budgetId);
    setExpenseStatus('');
    setExpenseError('');
    setError('');
    try {
      const res = await fetch(`http://localhost:8000/budgets/${encodeURIComponent(budgetId)}?user_id=${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || '删除预算失败');
      }
      if (selectedBudgetId === budgetId) {
        setSelectedBudgetId(null);
        setBudgetSummary(null);
      }
      await fetchBudgets(user.id);
      setExpenseStatus('预算已删除');
    } catch (e) {
      setError(e.message || '删除预算失败');
    } finally {
      setDeletingBudgetId(null);
    }
  };

  const startExpenseRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setExpenseError('当前浏览器不支持语音输入');
      return;
    }
    if (!selectedBudgetId) {
      setExpenseError('请先选择一个预算');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      expenseAudioBuffersRef.current = [];
      expenseSampleRateRef.current = audioContext.sampleRate;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        expenseAudioBuffersRef.current.push(input.slice());
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsRecordingExpense(true);
      setExpenseStatus('正在录音...');
      setExpenseError('');

      const stopRecording = () => {
        processor.disconnect();
        source.disconnect();
        audioContext.close();
        stream.getTracks().forEach((track) => track.stop());
        setIsRecordingExpense(false);
        processExpenseRecording().catch((err) => {
          setExpenseError(err.message || '处理语音失败');
        });
      };

      expenseRecorderRef.current = { stop: stopRecording };
    } catch (e) {
      setExpenseError(e.message || '无法开始录音');
      setIsRecordingExpense(false);
    }
  };

  const processExpenseRecording = async () => {
    const recordedBuffers = expenseAudioBuffersRef.current || [];
    const sampleRate = expenseSampleRateRef.current;
    if (!recordedBuffers.length || !sampleRate) {
      throw new Error('没有有效的音频数据');
    }
    const totalLength = recordedBuffers.reduce((acc, buf) => acc + buf.length, 0);
    const fullBuffer = new Float32Array(totalLength);
    let offset = 0;
    recordedBuffers.forEach((buf) => {
      fullBuffer.set(buf, offset);
      offset += buf.length;
    });
    const resampled = await resampleTo16kHQ(fullBuffer, sampleRate);
    const trimmed = trimSilence(resampled, 16000);
    const normalized = normalizeAudio(trimmed);
    const wavBlob = createWavBlobFromFloat32(normalized, 16000);
    await sendVoiceExpense(wavBlob);
  };

  const stopExpenseRecording = () => {
    if (expenseRecorderRef.current) {
      expenseRecorderRef.current.stop();
    }
  };

  const sendVoiceExpense = async (blob) => {
    if (!user?.id || !selectedBudgetId) return;
    if (blob.size < 100) {
      setExpenseError('录音太短，请重试');
      return;
    }
    setExpenseStatus('正在识别语音并添加开销...');
    setExpenseError('');
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'expense.wav');
      formData.append('budget_id', selectedBudgetId);
      formData.append('user_id', user.id);
      if (expenseForm.currency) {
        formData.append('currency_hint', expenseForm.currency);
      }
      if (expenseForm.category) {
        formData.append('fallback_category', expenseForm.category);
      }
      const res = await fetch('http://localhost:8000/expenses/voice', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || '语音开销添加失败');
      }
      setExpenseStatus('语音开销已记录');
      await fetchBudgetDetails(selectedBudgetId, user.id);
    } catch (e) {
      setExpenseError(e.message || '语音开销添加失败');
      setExpenseStatus('');
    }
  };

  if (!user?.id) {
    return (
      <div style={{ padding: 24, color: '#475569' }}>
        请先登录后再使用预算管理功能。
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 24, minHeight: 500 }}>
      <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h4 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>我的预算</h4>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {isLoadingBudgets ? '加载中...' : `${budgets.length} 个`}
          </span>
        </div>
        {error && (
          <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#b91c1c', fontSize: 13 }}>
            {error}
          </div>
        )}
        <form onSubmit={handleCreateBudget} style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#475569', fontWeight: 600 }}>新增预算</div>
          <input
            type="number"
            value={budgetForm.totalBudget}
            onChange={(e) => handleBudgetInputChange('totalBudget', e.target.value)}
            placeholder="预算总额（例如 10000）"
            style={inputStyle}
            min="0"
            step="0.01"
            required
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={budgetForm.currency}
              onChange={(e) => handleBudgetInputChange('currency', e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="CNY">CNY 人民币</option>
              <option value="USD">USD 美元</option>
              <option value="JPY">JPY 日元</option>
              <option value="EUR">EUR 欧元</option>
              <option value="HKD">HKD 港币</option>
            </select>
            <select
              value={budgetForm.planId}
              onChange={(e) => handleBudgetInputChange('planId', e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">不关联行程</option>
              {normalizedHistory.map((item) => (
                <option key={item.id} value={item.id}>
                  {renderPlanOptionLabel(item)}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={budgetForm.notes}
            onChange={(e) => handleBudgetInputChange('notes', e.target.value)}
            placeholder="备注（可选）"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
          <button
            type="submit"
            disabled={isCreatingBudget}
            style={primaryButtonStyle}
            onMouseOver={(e) => {
              if (!isCreatingBudget) e.currentTarget.style.background = 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
            }}
          >
            {isCreatingBudget ? '创建中...' : '创建预算'}
          </button>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {budgets.length === 0 ? (
            <div style={{ padding: 20, borderRadius: 12, border: '1px dashed #cbd5e1', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              暂无预算，请先创建。
            </div>
          ) : (
            budgets.map((budget) => {
              const isActive = budget.id === selectedBudgetId;
              const isDeleting = deletingBudgetId === budget.id;
              return (
                <div
                  key={budget.id}
                  onClick={() => setSelectedBudgetId(budget.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedBudgetId(budget.id);
                    }
                  }}
                  style={{
                    textAlign: 'left',
                    padding: 16,
                    borderRadius: 12,
                    border: isActive ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                    background: isActive ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff',
                    boxShadow: isActive ? '0 4px 12px rgba(59,130,246,0.15)' : '0 2px 4px rgba(15,23,42,0.04)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#0f172a', fontWeight: 600, marginBottom: 6 }}>
                      预算：{budget.currency || 'CNY'} {Number(budget.total_budget || 0).toLocaleString()}
                    </div>
                    {budget.notes && (
                      <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.5, marginBottom: 6 }}>
                        {budget.notes}
                      </div>
                    )}
                    <div style={{ color: '#94a3b8', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      创建时间：{budget.created_at ? new Date(budget.created_at).toLocaleString() : '未知'}
                      {budget.plan_id && (
                        <span>
                          关联行程：{renderPlanSummary(normalizedHistory, budget.plan_id)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteBudget(budget.id);
                    }}
                    disabled={isDeleting}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid #fca5a5',
                      background: isDeleting ? '#fecaca' : '#fee2e2',
                      color: '#b91c1c',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isDeleting ? 'not-allowed' : 'pointer',
                      minWidth: 70,
                      transition: 'background 0.2s, transform 0.2s'
                    }}
                    onMouseOver={(e) => {
                      if (isDeleting) return;
                      e.currentTarget.style.background = '#fca5a5';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.background = isDeleting ? '#fecaca' : '#fee2e2';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }}
                  >
                    {isDeleting ? '删除中…' : '删除'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {selectedBudgetId ? (
          <>
            <div>
              <h4 style={{ margin: 0, fontSize: 22, color: '#0f172a' }}>预算概览</h4>
              <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
                {isLoadingExpenses ? '正在加载...' : '查看实时预算状态'}
              </div>
            </div>

            {budgetSummary && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
                <SummaryCard
                  title="预算总额"
                  value={`${budgetSummary.currency || 'CNY'} ${(budgetSummary?.budget?.total_budget ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`}
                  accent="#3b82f6"
                />
                <SummaryCard
                  title="已花费"
                  value={`${budgetSummary.currency || 'CNY'} ${(budgetSummary.total_spent || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`}
                  accent="#ec4899"
                />
                <SummaryCard
                  title="剩余预算"
                  value={
                    budgetSummary.remaining != null
                      ? `${budgetSummary.currency || 'CNY'} ${budgetSummary.remaining.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
                      : '—'
                  }
                  accent="#16a34a"
                />
              </div>
            )}

            {budgetSummary?.by_category && Object.keys(budgetSummary.by_category).length > 0 && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 12 }}>分类统计</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {Object.entries(budgetSummary.by_category).map(([category, amount]) => (
                    <div key={category} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#475569' }}>
                      <span>{categoryLabel(category)}</span>
                      <span>{budgetSummary.currency || 'CNY'} {amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 12 }}>添加开销</div>
              <form onSubmit={handleAddExpense} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <input
                    type="number"
                    value={expenseForm.amount}
                    onChange={(e) => handleExpenseInputChange('amount', e.target.value)}
                    placeholder="金额"
                    style={{ ...inputStyle, flex: 1 }}
                    min="0"
                    step="0.01"
                    required
                  />
                  <select
                    value={expenseForm.currency}
                    onChange={(e) => handleExpenseInputChange('currency', e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  >
                    <option value="CNY">CNY</option>
                    <option value="USD">USD</option>
                    <option value="JPY">JPY</option>
                    <option value="EUR">EUR</option>
                    <option value="HKD">HKD</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <select
                    value={expenseForm.category}
                    onChange={(e) => handleExpenseInputChange('category', e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  >
                    {categoryOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={expenseForm.description}
                    onChange={(e) => handleExpenseInputChange('description', e.target.value)}
                    placeholder="描述（可选）"
                    style={{ ...inputStyle, flex: 2 }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <button
                    type="submit"
                    disabled={isAddingExpense}
                    style={{ ...primaryButtonStyle, flex: 1 }}
                    onMouseOver={(e) => {
                      if (!isAddingExpense) e.currentTarget.style.background = 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.background = 'linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%)';
                    }}
                  >
                    {isAddingExpense ? '提交中...' : '添加开销'}
                  </button>
                  <button
                    type="button"
                    onClick={isRecordingExpense ? stopExpenseRecording : startExpenseRecording}
                    style={{
                      padding: '10px 16px',
                      borderRadius: 10,
                      border: 'none',
                      cursor: 'pointer',
                      background: isRecordingExpense
                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                        : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                      color: '#fff',
                      fontWeight: 600,
                      boxShadow: isRecordingExpense
                        ? '0 4px 12px rgba(239, 68, 68, 0.4)'
                        : '0 4px 12px rgba(34, 197, 94, 0.4)',
                      transition: 'transform 0.2s, box-shadow 0.2s',
                    }}
                    onMouseOver={(e) => {
                      if (!isRecordingExpense) {
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                    }}
                  >
                    {isRecordingExpense ? '⏹ 停止语音记账' : '🎙 语音记账'}
                  </button>
                </div>
              </form>
              {(expenseStatus || expenseError) && (
                <div style={{ marginTop: 10, fontSize: 13, color: expenseError ? '#b91c1c' : '#0f766e' }}>
                  {expenseError || expenseStatus}
                </div>
              )}
            </div>

            <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, flex: 1, overflow: 'auto' }}>
              <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 12 }}>开销记录</div>
              {budgetSummary?.items?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {budgetSummary.items.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        padding: 14,
                        borderRadius: 10,
                        border: '1px solid #e2e8f0',
                        background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                        boxShadow: '0 2px 6px rgba(15,23,42,0.06)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: '#0f172a' }}>
                          {categoryLabel(item.category)} · {item.currency || budgetSummary.currency || 'CNY'} {Number(item.amount || 0).toLocaleString()}
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: 12 }}>
                          {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
                        </span>
                      </div>
                      {item.description && (
                        <div style={{ color: '#475569', fontSize: 13, marginBottom: 6 }}>{item.description}</div>
                      )}
                      {item.source === 'voice' && item.transcript && (
                        <div style={{ color: '#0f766e', fontSize: 12 }}>
                          语音原文：{item.transcript}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 20, borderRadius: 10, border: '1px dashed #cbd5e1', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                  暂无开销记录，试试添加一笔吧。
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
            请选择左侧的预算或创建新的预算。
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ title, value, accent }) {
  return (
    <div
      style={{
        borderRadius: 12,
        padding: 16,
        background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 10px rgba(15,23,42,0.06)',
      }}
    >
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );
}

function categoryLabel(category) {
  const found = categoryOptions.find((item) => item.value === category);
  return found ? found.label : category || '其他';
}

function renderPlanOptionLabel(plan) {
  if (!plan) return '未命名行程';
  const idLabel = plan.id != null ? `#${plan.id}` : '';
  const textSource = plan.text || plan.plan || '';
  const trimmed = textSource.replace(/\s+/g, ' ').trim().slice(0, 30);
  const suffix = trimmed ? `${trimmed}${textSource.length > 30 ? '…' : ''}` : '无标题行程';
  return `${idLabel} ${suffix}`.trim();
}

function renderPlanSummary(history, planId) {
  if (!history || !planId) return `ID ${planId}`;
  const match = history.find((item) => String(item.id) === String(planId));
  if (!match) return `ID ${planId}`;
  return renderPlanOptionLabel(match);
}

const inputStyle = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  fontSize: 14,
  color: '#0f172a',
  outline: 'none',
  background: '#ffffff',
  boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.05)',
};

const primaryButtonStyle = {
  padding: '10px 16px',
  borderRadius: 10,
  border: 'none',
  cursor: 'pointer',
  background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
  color: '#fff',
  fontWeight: 600,
  boxShadow: '0 4px 12px rgba(59,130,246,0.25)',
  transition: 'transform 0.2s, box-shadow 0.2s, background 0.2s',
};

export default BudgetPanel;


