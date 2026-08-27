import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientMessage, MatchState, ServerMessage, Target } from './protocol'
import { fromPublicRoom } from './protocol'
import { useGameSocket } from './useGameSocket'
import { playArcadeSound, type ArcadeSound } from './arcadeAudio'

type Screen = 'home' | 'lobby' | 'game' | 'result'
type Toast = { text: string; tone: 'good' | 'bad' | 'info' }
type InputFeedback = ArcadeSound | null
const WORDS = ['번개', '스테이지', '콤보', '네온사인', '하이스코어', '동전', '보너스', '아케이드', '도전', '승부', '픽셀', '출발']
const starterTargets = (): Target[] => WORDS.slice(0, 5).map((text, i) => ({ id: `demo-${i}-${Date.now()}`, text, points: 100 + i * 20 }))

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [nickname, setNickname] = useState('')
  const [nicknameRequired, setNicknameRequired] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [playerId, setPlayerId] = useState('me')
  const [state, setState] = useState<MatchState>({ roomCode: '', phase: 'lobby', targets: [], players: [] })
  const [input, setInput] = useState('')
  const [seconds, setSeconds] = useState(60)
  const [toast, setToast] = useState<Toast | null>(null)
  const [effect, setEffect] = useState<'blur' | 'ink' | 'shake' | null>(null)
  const [inputFeedback, setInputFeedback] = useState<InputFeedback>(null)
  const [burstIndex, setBurstIndex] = useState<number | null>(null)
  const [reduced, setReduced] = useState(() => localStorage.getItem('reducedEffects') === 'true')
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('soundEnabled') !== 'false')
  const [demo, setDemo] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nicknameRef = useRef<HTMLInputElement>(null)

  const triggerFeedback = useCallback((kind: ArcadeSound, targetId?: string) => {
    playArcadeSound(kind, soundEnabled)
    setInputFeedback(kind)
    if (kind === 'success' && targetId) {
      const index = state.targets.findIndex(target => target.id === targetId)
      if (index >= 0) setBurstIndex(index)
    }
    window.setTimeout(() => setInputFeedback(null), reduced ? 120 : 360)
    window.setTimeout(() => setBurstIndex(null), reduced ? 120 : 520)
  }, [reduced, soundEnabled, state.targets])

  const onServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === 'connected') {
      setPlayerId(message.playerId)
    } else if (['room_created', 'room_joined', 'room_state', 'match_started', 'match_ended'].includes(message.type)) {
      const roomMessage = message as Extract<ServerMessage, { room: unknown }>
      const next = fromPublicRoom(roomMessage.room)
      setState(next)
      setScreen(next.phase === 'playing' ? 'game' : next.phase === 'finished' ? 'result' : 'lobby')
      if (next.phase === 'playing') window.setTimeout(() => inputRef.current?.focus(), 50)
    } else if (message.type === 'submission_result') {
      if (message.playerId === playerId) {
        setToast(message.outcome === 'success' ? { text: `CATCH! +${message.scoreDelta}`, tone: 'good' } : message.outcome === 'claimed' ? { text: '한발 늦었어요!', tone: 'info' } : { text: 'MISS!', tone: 'bad' })
        triggerFeedback(message.outcome === 'success' ? 'success' : message.outcome === 'claimed' ? 'claimed' : 'miss', message.targetId)
      }
    } else if (message.type === 'interference') {
      if (message.toPlayerId === playerId) { setEffect(message.effect); window.setTimeout(() => setEffect(null), reduced ? Math.min(250, message.durationMs) : message.durationMs) }
    } else if (message.type === 'error') setToast({ text: `입장할 수 없어요 · ${message.code}`, tone: 'bad' })
  }, [playerId, reduced, triggerFeedback])
  const { status, connect, send } = useGameSocket(onServerMessage)

  useEffect(() => { if (screen !== 'game' || state.phase !== 'playing') return; const tick = () => { const left = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)) : seconds; setSeconds(left); if (left === 0) setScreen('result') }; tick(); const id = window.setInterval(tick, 250); return () => clearInterval(id) }, [screen, state.endsAt, state.phase])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 900); return () => clearTimeout(id) }, [toast])
  useEffect(() => { localStorage.setItem('reducedEffects', String(reduced)) }, [reduced])
  useEffect(() => { localStorage.setItem('soundEnabled', String(soundEnabled)) }, [soundEnabled])

  const enterRoom = (mode: 'create' | 'join') => {
    if (!nickname.trim()) { setNicknameRequired(true); setToast({ text: 'STEP 1 · 닉네임을 먼저 입력해 주세요', tone: 'bad' }); nicknameRef.current?.focus(); return }
    if (mode === 'join' && roomInput.trim().length < 4) { setToast({ text: '방 코드를 확인해 주세요', tone: 'bad' }); return }
    const message: ClientMessage = mode === 'create' ? { type: 'create_room', name: nickname.trim() } : { type: 'join_room', name: nickname.trim(), roomId: roomInput.trim().toUpperCase() }
    connect(message)
  }
  const startDemo = (code = 'PIXEL') => {
    setDemo(true); setPlayerId('me'); setState({ roomCode: code || 'PIXEL', phase: 'lobby', targets: [], players: [{ id: 'me', nickname: nickname.trim() || 'PLAYER 1', score: 0, combo: 0 }, { id: 'bot', nickname: 'TURBO.K', score: 0, combo: 0 }] }); setScreen('lobby')
  }
  const startGame = () => {
    if (!demo && send({ type: 'start_match' })) return
    const now = Date.now(); setSeconds(60); setState(s => ({ ...s, phase: 'playing', targets: starterTargets(), endsAt: now + 60000, durationMs: 60000 })); setScreen('game'); window.setTimeout(() => inputRef.current?.focus(), 50)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault(); const text = input.trim(); if (!text) return
    const target = state.targets.find(t => t.text === text)
    if (!demo && target && send({ type: 'submit', targetId: target.id, text })) { setInput(''); return }
    if (!demo && !target) { send({ type: 'submit', targetId: 'no-matching-target', text }); setInput(''); return }
    if (!target) { setToast({ text: 'MISS! 콤보가 끊겼어요', tone: 'bad' }); triggerFeedback('miss'); setState(s => ({ ...s, players: s.players.map(p => p.id === playerId ? { ...p, combo: 0 } : p) })); setInput(''); return }
    const me = state.players.find(p => p.id === playerId)!; const nextCombo = me.combo + 1
    setState(s => ({ ...s, targets: s.targets.map(t => t.id === target.id ? { id: `demo-${Math.random()}`, text: WORDS[Math.floor(Math.random() * WORDS.length)], points: 100 + Math.floor(Math.random() * 3) * 20 } : t), players: s.players.map(p => p.id === playerId ? { ...p, score: p.score + (target.points ?? 100), combo: nextCombo } : p) }))
    setToast({ text: `CATCH! +${target.points ?? 100}`, tone: 'good' }); triggerFeedback('success', target.id); setInput('')
    if ([5, 8, 12].includes(nextCombo)) { setEffect(nextCombo >= 12 ? 'ink' : nextCombo >= 8 ? 'blur' : 'shake'); window.setTimeout(() => setEffect(null), reduced ? 250 : 900) }
  }

  const sorted = useMemo(() => [...state.players].sort((a, b) => b.score - a.score), [state.players])
  const me = state.players.find(p => p.id === playerId) ?? sorted[0]
  const prefixMatches = (target: Target) => !!input && target.text.startsWith(input)
  const hasNickname = nickname.trim().length > 0

  return <div className={`app ${reduced ? 'reduced' : ''}`}>
    <div className="crt" aria-hidden="true" />
    <header className="topbar">
      <button className="brand" onClick={() => setScreen('home')} aria-label="첫 화면으로"><span>CATCH</span> TYPING <i>!</i></button>
      <div className="preferences"><button className="sound-toggle" onClick={() => setSoundEnabled(value => !value)} aria-pressed={soundEnabled} aria-label={soundEnabled ? '효과음 끄기' : '효과음 켜기'}>{soundEnabled ? '♪ SOUND' : '× MUTED'}</button><label className="effects"><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> <span>효과 줄이기</span></label></div>
    </header>

    {screen === 'home' && <main className="home">
      <section className="hero">
        <div className="coin">C</div><p className="eyebrow">INSERT COIN · TYPE TO WIN</p>
        <h1><span>단어를 보고,</span><br />먼저 <em>낚아채세요!</em></h1>
        <p className="lead">눈치보다 빠르게. 생각보다 정확하게.<br />친구들과 겨루는 실시간 타이핑 아케이드.</p>
      </section>
      <section className="cabinet" aria-label="게임 입장">
        <div className="cabinet-marquee">WORD BATTLE</div>
        <div className="cabinet-screen">
          <div className="status-line"><span>PLAYER SETUP</span><b className={hasNickname ? 'ready' : 'required'}>{hasNickname ? '● READY' : '○ NAME REQUIRED'}</b></div>
          <section className={`setup-step ${hasNickname ? 'complete' : ''}`} aria-labelledby="player-step-title">
            <div className="step-heading"><span>1</span><div><strong id="player-step-title">플레이어 정보</strong><small>게임 생성과 참가에 모두 사용돼요</small></div>{hasNickname && <i>✓</i>}</div>
            <label>닉네임 <em>필수</em><input ref={nicknameRef} maxLength={12} value={nickname} onChange={e => { setNickname(e.target.value); setNicknameRequired(false) }} placeholder="이름을 입력하세요" autoComplete="nickname" aria-invalid={nicknameRequired} /></label>
            {nicknameRequired && <p className="field-error" role="alert">먼저 사용할 닉네임을 입력해 주세요.</p>}
          </section>
          <section className={`setup-step play-step ${hasNickname ? '' : 'locked'}`} aria-labelledby="play-step-title">
            <div className="step-heading"><span>2</span><div><strong id="play-step-title">플레이 방법 선택</strong><small>{hasNickname ? '새 방을 만들거나 기존 방에 참가하세요' : '닉네임 입력 후 선택할 수 있어요'}</small></div></div>
            <button className="primary" aria-disabled={!hasNickname} onClick={() => enterRoom('create')}>새 게임 만들기 <kbd>↵</kbd></button>
            <div className="divider"><span>또는 기존 방 참가</span></div>
            <label>방 코드<div className="join-row"><input maxLength={6} value={roomInput} onChange={e => setRoomInput(e.target.value.toUpperCase())} onClick={() => { if (!hasNickname) { setNicknameRequired(true); nicknameRef.current?.focus() } }} readOnly={!hasNickname} aria-disabled={!hasNickname} placeholder={hasNickname ? '예: PIXEL' : '닉네임 입력 후 활성화'} /><button aria-disabled={!hasNickname} onClick={() => enterRoom('join')}>참가하기</button></div></label>
          </section>
          <button className="demo-link" onClick={() => startDemo()}>혼자 연습해 보기 →</button>
        </div>
        <div className="cabinet-controls"><i /><i /><span /></div>
      </section>
      <div className="how"><span>01 방 만들기</span><b>→</b><span>02 코드 공유</span><b>→</b><span>03 타이핑!</span></div>
    </main>}

    {screen === 'lobby' && <main className="lobby">
      <p className="eyebrow">NOW ENTERING</p><h1>네온 스트리트 <span>01</span></h1>
      <section className="room-panel">
        <div><small>ROOM CODE</small><button className="room-code" onClick={() => navigator.clipboard?.writeText(state.roomCode)}>{state.roomCode} <span>⧉</span></button><p>코드를 눌러 복사하고 친구에게 알려주세요.</p></div>
        <div className={`connection ${demo ? 'demo' : status}`}>● {demo ? '연습 모드' : status === 'online' ? '서버 연결됨' : '연결 확인 중'}</div>
      </section>
      <section className="players"><div className="section-title"><h2>PLAYERS</h2><span>{state.players.length} / 4</span></div>{state.players.map((p, i) => <div className="player-slot" key={p.id}><strong>P{i + 1}</strong><div className={`avatar a${i + 1}`}>{p.nickname.charAt(0)}</div><span>{p.nickname}</span><i>READY</i></div>)}{Array.from({ length: Math.max(0, 4 - state.players.length) }, (_, i) => <div className="player-slot empty" key={i}><strong>?</strong><div className="avatar">+</div><span>친구를 기다리는 중...</span><i>WAIT</i></div>)}</section>
      <div className="lobby-actions"><button className="ghost" onClick={() => setScreen('home')}>← 나가기</button>{demo || state.hostId === playerId ? <button className="primary big" onClick={startGame}>게임 시작 <span>READY?</span></button> : <div className="waiting-host" role="status">방장이 게임을 시작하기를 기다리는 중…</div>}</div>
    </main>}

    {screen === 'game' && <main className={`game feedback-${inputFeedback ?? 'idle'}`} onClick={() => inputRef.current?.focus()}>
      <div className="game-hud"><div><small>ROOM</small><b>{state.roomCode}</b></div><div className={`timer ${seconds <= 10 ? 'danger' : ''}`}><small>TIME</small><strong>{String(seconds).padStart(2, '0')}<i>s</i></strong></div><div className="combo"><small>COMBO</small><b>× {me?.combo ?? 0}</b></div></div>
      <div className="scoreboard">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><span>{i + 1}</span><b>{p.nickname}</b><em>{p.score.toLocaleString()}</em></div>)}</div>
      <section className="arena">
        <p className="arena-label">TYPE ONE & PRESS ENTER</p>
        <div className="targets">{state.targets.map((target, i) => <article key={target.id} className={`${prefixMatches(target) ? 'matching' : ''} ${burstIndex === i ? 'bursting' : ''} target-${i}`}><small>{target.points ?? 100} PTS</small><strong>{target.text}</strong><span>{input && prefixMatches(target) ? `${input.length}/${target.text.length}` : 'LOCK ON'}</span>{burstIndex === i && <div className="pixel-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, pixel) => <i key={pixel} style={{ '--pixel': pixel } as React.CSSProperties} />)}</div>}</article>)}</div>
        <form className={`type-form ${inputFeedback ? `is-${inputFeedback}` : ''}`} onSubmit={submit}><div className="prompt">›</div><input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder="단어를 입력하세요" autoComplete="off" spellCheck={false} aria-label="단어 입력" /><button>ENTER ↵</button></form>
        <p className="tip">화면의 단어를 정확히 입력하고 ENTER! 가장 먼저 보낸 사람이 점수를 얻어요.</p>
      </section>
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
      {effect === 'blur' && <div className="interference blurfx"><b>BLUR ATTACK!</b></div>}
      {effect === 'ink' && <div className="interference inkfx"><i /><i /><i /><b>INK ATTACK!</b></div>}
      {effect === 'shake' && <div className="interference shakefx"><b>SHAKE!</b></div>}
    </main>}

    {screen === 'result' && <main className="result">
      <p className="eyebrow">GAME CLEAR</p><h1>{sorted[0]?.id === playerId ? 'YOU WIN!' : 'NICE TRY!'}</h1>
      <div className="trophy">★</div><h2>{sorted[0]?.nickname}</h2><p className="final-score">{sorted[0]?.score.toLocaleString()} <small>PTS</small></p>
      <section className="results-table">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><strong>#{i + 1}</strong><span>{p.nickname}</span><b>{p.score.toLocaleString()}</b><em>MAX ×{p.combo}</em></div>)}</section>
      <div className="result-actions"><button className="primary" onClick={startGame}>한 판 더!</button><button className="ghost" onClick={() => setScreen('lobby')}>대기실로</button></div>
    </main>}
    <footer>© 20XX CATCH TYPING · BEST PLAYED WITH A KEYBOARD</footer>
  </div>
}

export default App
