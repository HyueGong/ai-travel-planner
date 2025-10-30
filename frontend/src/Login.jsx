import { useState } from 'react'

export default function Login({ onAuthed }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('signin') // signin | signup
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`http://localhost:8000/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || data.message || '请求失败')
      const user = { id: data.user_id, email }
      localStorage.setItem('user', JSON.stringify(user))
      onAuthed(user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #eef2ff 0%, #e0f7fa 100%)',
      fontFamily: 'sans-serif'
    }}>
      <div style={{
        width: 'min(420px, 90vw)',
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: '0 10px 24px rgba(0,0,0,0.08)',
        padding: 28
      }}>
        <h2 style={{ textAlign: 'center', marginTop: 0 }}>{mode === 'signin' ? '登录' : '注册'}</h2>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#555' }}>邮箱</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd' }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#555' }}>密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd' }} />
          </div>
          {error && <div style={{ color: 'red', marginBottom: 8 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', padding: 10, borderRadius: 8, background: '#2563eb', color: '#fff', border: 'none' }}>
            {loading ? '提交中...' : (mode === 'signin' ? '登录' : '注册')}
          </button>
        </form>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')} style={{ background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer' }}>
            切换到{mode === 'signin' ? '注册' : '登录'}
          </button>
        </div>
      </div>
    </div>
  )
}


