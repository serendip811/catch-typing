import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientMessage, MatchState, ServerMessage, Target } from './protocol'
import { fromPublicRoom } from './protocol'
import { useGameSocket } from './useGameSocket'
import { playArcadeSound, type ArcadeSound } from './arcadeAudio'

type Screen = 'home' | 'lobby' | 'game' | 'result'
type GameMode = 'grab' | 'shoot'
type Toast = { text: string; tone: 'good' | 'bad' | 'info' }
type InputFeedback = ArcadeSound | null
const WORDS = ['번개', '스테이지', '콤보', '네온사인', '하이스코어', '동전', '보너스', '아케이드', '도전', '승부', '픽셀', '출발']
const starterTargets = (): Target[] => WORDS.slice(0, 5).map((text, i) => ({ id: `demo-${i}-${Date.now()}`, text, points: 100 + i * 20 }))
const roomFromUrl = () => new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) ?? ''
const emptyRoom = (): MatchState => ({ roomCode: '', phase: 'lobby', targets: [], players: [] })

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [nickname, setNickname] = useState('')
  const [nicknameRequired, setNicknameRequired] = useState(false)
  const [inviteRoomCode, setInviteRoomCode] = useState(roomFromUrl)
  const [roomInput, setRoomInput] = useState(roomFromUrl)
  const [expiredRoomCode, setExpiredRoomCode] = useState('')
  const [playerId, setPlayerId] = useState('me')
  const [state, setState] = useState<MatchState>(emptyRoom)
  const [input, setInput] = useState('')
  const [seconds, setSeconds] = useState(60)
  const [toast, setToast] = useState<Toast | null>(null)
  const [effect, setEffect] = useState<'blur' | 'ink' | 'shake' | null>(null)
  const [inputFeedback, setInputFeedback] = useState<InputFeedback>(null)
  const [burstIndex, setBurstIndex] = useState<number | null>(null)
  const [reduced, setReduced] = useState(() => localStorage.getItem('reducedEffects') === 'true')
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('soundEnabled') !== 'false')
  const [demo, setDemo] = useState(false)
  const [gameMode, setGameMode] = useState<GameMode>('grab')
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nicknameRef = useRef<HTMLInputElement>(null)
  const pendingRoomRef = useRef('')
  const viewportBaselineRef = useRef(0)

  const triggerFeedback = useCallback((kind: ArcadeSound, targetId?: string) => {
    playArcadeSound(kind, soundEnabled, gameMode === 'shoot')
    setInputFeedback(kind)
    if (kind === 'success' && targetId) {
      const index = state.targets.findIndex(target => target.id === targetId)
      if (index >= 0) setBurstIndex(index)
    }
    window.setTimeout(() => setInputFeedback(null), reduced ? 120 : 360)
    window.setTimeout(() => setBurstIndex(null), reduced ? 120 : 520)
  }, [gameMode, reduced, soundEnabled, state.targets])

  const onServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === 'connected') {
      setPlayerId(message.playerId)
    } else if (message.type === 'room_left') {
      setState(emptyRoom())
      setScreen('home')
    } else if (['room_created', 'room_joined', 'room_state', 'match_started', 'match_ended'].includes(message.type)) {
      const roomMessage = message as Extract<ServerMessage, { room: unknown }>
      const next = fromPublicRoom(roomMessage.room)
      setState(next)
      setExpiredRoomCode('')
      setScreen(next.phase === 'playing' ? 'game' : next.phase === 'finished' ? 'result' : 'lobby')
      if (next.phase === 'playing') window.setTimeout(() => inputRef.current?.focus(), 50)
    } else if (message.type === 'submission_result') {
      if (message.playerId === playerId) {
        setToast(message.outcome === 'success' ? { text: `CATCH! +${message.scoreDelta}`, tone: 'good' } : message.outcome === 'claimed' ? { text: '한발 늦었어요!', tone: 'info' } : { text: 'MISS!', tone: 'bad' })
        triggerFeedback(message.outcome === 'success' ? 'success' : message.outcome === 'claimed' ? 'claimed' : 'miss', message.targetId)
      }
    } else if (message.type === 'interference') {
      if (message.toPlayerId === playerId) { setEffect(message.effect); window.setTimeout(() => setEffect(null), reduced ? Math.min(250, message.durationMs) : message.durationMs) }
    } else if (message.type === 'error') {
      if (message.code === 'ROOM_NOT_FOUND') {
        setExpiredRoomCode(pendingRoomRef.current)
        setInviteRoomCode('')
        setRoomInput('')
        window.history.replaceState({}, '', window.location.pathname)
        setToast({ text: '이미 종료되었거나 존재하지 않는 방이에요', tone: 'bad' })
      } else {
        const errorText: Record<string, string> = {
          ROOM_FULL: '방이 가득 찼어요',
          MATCH_ALREADY_STARTED: '이미 게임이 시작된 방이에요',
          NOT_ENOUGH_PLAYERS: '두 명 이상 모여야 시작할 수 있어요',
          HOST_ONLY: '방장만 할 수 있어요',
        }
        setToast({ text: errorText[message.code] ?? `요청을 처리할 수 없어요 · ${message.code}`, tone: 'bad' })
      }
    }
  }, [playerId, reduced, triggerFeedback])
  const { status, connect, disconnect, send } = useGameSocket(onServerMessage)

  useEffect(() => { if (screen !== 'game' || state.phase !== 'playing') return; const tick = () => { const left = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)) : seconds; setSeconds(left); if (left === 0) setScreen('result') }; tick(); const id = window.setInterval(tick, 250); return () => clearInterval(id) }, [screen, state.endsAt, state.phase])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 900); return () => clearTimeout(id) }, [toast])
  useEffect(() => { localStorage.setItem('reducedEffects', String(reduced)) }, [reduced])
  useEffect(() => { localStorage.setItem('soundEnabled', String(soundEnabled)) }, [soundEnabled])
  useEffect(() => {
    if (screen !== 'game' || !window.visualViewport) {
      setKeyboardOpen(false)
      return
    }
    const viewport = window.visualViewport
    let frame = 0
    viewportBaselineRef.current = viewport.height
    const updateViewport = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        viewportBaselineRef.current = Math.max(viewportBaselineRef.current, viewport.height)
        const open = viewportBaselineRef.current - viewport.height > 180
        document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(viewport.height)}px`)
        document.documentElement.style.setProperty('--visual-viewport-top', `${Math.round(viewport.offsetTop)}px`)
        setKeyboardOpen(open)
        if (open) window.scrollTo({ top: 0, behavior: 'auto' })
      })
    }
    updateViewport()
    viewport.addEventListener('resize', updateViewport)
    viewport.addEventListener('scroll', updateViewport)
    return () => {
      window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', updateViewport)
      viewport.removeEventListener('scroll', updateViewport)
      document.documentElement.style.removeProperty('--visual-viewport-height')
      document.documentElement.style.removeProperty('--visual-viewport-top')
      setKeyboardOpen(false)
    }
  }, [screen])
  useEffect(() => {
    if (status !== 'offline' || demo || screen === 'home') return
    setToast({ text: '서버 연결이 끊어져 방에서 나왔어요', tone: 'bad' })
    setState(emptyRoom())
    setScreen('home')
  }, [demo, screen, status])
  useEffect(() => {
    if (expiredRoomCode) disconnect()
  }, [disconnect, expiredRoomCode])

  const enterRoom = (mode: 'create' | 'join') => {
    if (!nickname.trim()) { setNicknameRequired(true); setToast({ text: 'STEP 1 · 닉네임을 먼저 입력해 주세요', tone: 'bad' }); nicknameRef.current?.focus(); return }
    if (mode === 'join' && roomInput.trim().length < 4) { setToast({ text: '방 코드를 확인해 주세요', tone: 'bad' }); return }
    setExpiredRoomCode('')
    setGameMode('grab')
    pendingRoomRef.current = mode === 'join' ? roomInput.trim().toUpperCase() : ''
    const message: ClientMessage = mode === 'create' ? { type: 'create_room', name: nickname.trim() } : { type: 'join_room', name: nickname.trim(), roomId: roomInput.trim().toUpperCase() }
    connect(message)
  }
  const startDemo = (mode: GameMode = 'grab') => {
    setGameMode(mode); setDemo(true); setPlayerId('me'); setState({ roomCode: mode === 'shoot' ? 'RANGE' : 'PIXEL', phase: 'lobby', targets: [], players: [{ id: 'me', nickname: nickname.trim() || 'PLAYER 1', score: 0, combo: 0 }, { id: 'bot', nickname: 'TURBO.K', score: 0, combo: 0 }] }); setScreen('lobby')
  }
  const leaveInvite = () => {
    setInviteRoomCode(''); setRoomInput(''); setExpiredRoomCode(''); setNicknameRequired(false)
    window.history.replaceState({}, '', window.location.pathname)
  }
  const inviteUrl = useMemo(() => {
    const url = new URL(import.meta.env.BASE_URL, window.location.origin)
    url.searchParams.set('room', state.roomCode)
    return url.toString()
  }, [state.roomCode])
  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setToast({ text: '초대 링크를 복사했어요!', tone: 'good' })
    } catch {
      setToast({ text: '링크를 복사하지 못했어요', tone: 'bad' })
    }
  }
  const exitRoom = () => {
    if (!demo) send({ type: 'leave_room' })
    disconnect()
    setDemo(false)
    setGameMode('grab')
    setState(emptyRoom())
    setScreen('home')
  }
  const startGame = () => {
    if (!demo) {
      if (!send({ type: 'start_match' })) setToast({ text: '서버에 연결되어 있지 않아요', tone: 'bad' })
      return
    }
    const now = Date.now(); setSeconds(60); setState(s => ({ ...s, phase: 'playing', targets: starterTargets(), endsAt: now + 60000, durationMs: 60000 })); setScreen('game'); window.setTimeout(() => inputRef.current?.focus(), 50)
  }
  const returnToLobby = () => {
    if (!demo) {
      if (!send({ type: 'return_to_lobby' })) setToast({ text: '서버에 연결되어 있지 않아요', tone: 'bad' })
      return
    }
    setState(s => ({ ...s, phase: 'lobby', targets: [], endsAt: undefined, players: s.players.map(p => ({ ...p, score: 0, combo: 0 })) }))
    setScreen('lobby')
  }
  const submit = (event: FormEvent) => {
    event.preventDefault(); const text = input.trim(); if (!text) return
    const target = state.targets.find(t => t.text === text)
    if (!demo) {
      const sent = send({ type: 'submit', targetId: target?.id ?? 'no-matching-target', text })
      if (!sent) setToast({ text: '서버 연결을 확인해 주세요', tone: 'bad' })
      if (sent) setInput('')
      return
    }
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

  return <div className={`app ${reduced ? 'reduced' : ''} ${keyboardOpen ? 'keyboard-open' : ''}`}>
    <div className="crt" aria-hidden="true" />
    <header className="topbar">
      <button className="brand" onClick={exitRoom} aria-label="첫 화면으로"><span>CATCH</span> TYPING <i>!</i></button>
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
          <div className="status-line"><span>{inviteRoomCode ? 'ROOM INVITATION' : 'PLAYER SETUP'}</span><b className={hasNickname ? 'ready' : 'required'}>{hasNickname ? '● READY' : '○ NAME REQUIRED'}</b></div>
          {expiredRoomCode && <div className="expired-room" role="alert"><strong>ROOM {expiredRoomCode || 'UNKNOWN'} 종료됨</strong><span>이미 없어졌거나 서버 재시작으로 만료된 방이에요.<br />새 방을 만들거나 다른 방 코드를 입력해 주세요.</span><button onClick={() => setExpiredRoomCode('')} aria-label="안내 닫기">×</button></div>}
          <section className={`setup-step ${hasNickname ? 'complete' : ''}`} aria-labelledby="player-step-title">
            <div className="step-heading"><span>1</span><div><strong id="player-step-title">{inviteRoomCode ? '초대받은 플레이어' : '플레이어 정보'}</strong><small>{inviteRoomCode ? `${inviteRoomCode} 방에서 사용할 이름을 정하세요` : '게임 생성과 참가에 모두 사용돼요'}</small></div>{hasNickname && <i>✓</i>}</div>
            <label>닉네임 <em>필수</em><input ref={nicknameRef} maxLength={12} value={nickname} onChange={e => { setNickname(e.target.value); setNicknameRequired(false) }} placeholder="이름을 입력하세요" autoComplete="nickname" aria-invalid={nicknameRequired} /></label>
            {nicknameRequired && <p className="field-error" role="alert">먼저 사용할 닉네임을 입력해 주세요.</p>}
          </section>
          {inviteRoomCode ? <section className={`setup-step invite-step ${hasNickname ? '' : 'locked'}`} aria-labelledby="invite-step-title">
            <div className="step-heading"><span>2</span><div><strong id="invite-step-title">초대받은 방 참가</strong><small>방 코드는 링크에서 자동으로 확인했어요</small></div></div>
            <div className="invited-room"><small>ROOM CODE</small><b>{inviteRoomCode}</b></div>
            <button className="primary invite-join" aria-disabled={!hasNickname} onClick={() => enterRoom('join')}>닉네임으로 바로 참가 <kbd>↵</kbd></button>
          </section> : <section className={`setup-step play-step ${hasNickname ? '' : 'locked'}`} aria-labelledby="play-step-title">
            <div className="step-heading"><span>2</span><div><strong id="play-step-title">플레이 방법 선택</strong><small>{hasNickname ? '새 방을 만들거나 기존 방에 참가하세요' : '닉네임 입력 후 선택할 수 있어요'}</small></div></div>
            <button className="primary" aria-disabled={!hasNickname} onClick={() => enterRoom('create')}>새 게임 만들기 <kbd>↵</kbd></button>
            <div className="divider"><span>또는 기존 방 참가</span></div>
            <label>방 코드<div className="join-row"><input maxLength={6} value={roomInput} onChange={e => { setRoomInput(e.target.value.toUpperCase()); setExpiredRoomCode('') }} onClick={() => { if (!hasNickname) { setNicknameRequired(true); nicknameRef.current?.focus() } }} readOnly={!hasNickname} aria-disabled={!hasNickname} placeholder={hasNickname ? '예: PIXEL' : '닉네임 입력 후 활성화'} /><button aria-disabled={!hasNickname} onClick={() => enterRoom('join')}>참가하기</button></div></label>
          </section>}
          {inviteRoomCode ? <button className="demo-link" onClick={leaveInvite}>다른 방법으로 시작하기 →</button> : <div className="demo-actions"><button className="demo-link" onClick={() => startDemo('grab')}>단어 쟁탈 연습 →</button><button className="demo-link shoot-link" onClick={() => startDemo('shoot')}>접시 사격 테스트 →</button></div>}
        </div>
        <div className="cabinet-controls"><i /><i /><span /></div>
      </section>
      <div className="how"><span>01 방 만들기</span><b>→</b><span>02 코드 공유</span><b>→</b><span>03 타이핑!</span></div>
    </main>}

    {screen === 'lobby' && <main className="lobby">
      <p className="eyebrow">NOW ENTERING</p><h1>{gameMode === 'shoot' ? '타이프 앤 슛' : '네온 스트리트'} <span>{gameMode === 'shoot' ? '02' : '01'}</span></h1>
      <section className="room-panel">
        <div><small>ROOM CODE</small><button className="room-code" onClick={() => navigator.clipboard?.writeText(state.roomCode)}>{state.roomCode} <span>⧉</span></button><button className="invite-link" onClick={copyInviteLink}>⌁ 초대 링크 복사</button><p>친구는 링크를 열고 닉네임만 입력하면 참가할 수 있어요.</p></div>
        <div className={`connection ${demo ? 'demo' : status}`}>● {demo ? '연습 모드' : status === 'online' ? '서버 연결됨' : '연결 확인 중'}</div>
      </section>
      <section className="players"><div className="section-title"><h2>PLAYERS</h2><span>{state.players.length} / 5</span></div>{state.players.map((p, i) => <div className="player-slot" key={p.id}><strong>P{i + 1}</strong><div className={`avatar a${i + 1}`}>{p.nickname.charAt(0)}</div><span>{p.nickname}</span><i>READY</i></div>)}{Array.from({ length: Math.max(0, 5 - state.players.length) }, (_, i) => <div className="player-slot empty" key={i}><strong>?</strong><div className="avatar">+</div><span>친구를 기다리는 중...</span><i>WAIT</i></div>)}</section>
      <div className="lobby-actions"><button className="ghost" onClick={exitRoom}>← 나가기</button>{demo || state.hostId === playerId ? <button className="primary big" onClick={startGame}>게임 시작 <span>READY?</span></button> : <div className="waiting-host" role="status">방장이 게임을 시작하기를 기다리는 중…</div>}</div>
    </main>}

    {screen === 'game' && <main className={`game mode-${gameMode} feedback-${inputFeedback ?? 'idle'}`} onClick={() => inputRef.current?.focus()}>
      <div className="game-hud"><div><small>{gameMode === 'shoot' ? 'MODE' : 'ROOM'}</small><b>{gameMode === 'shoot' ? 'TYPE & SHOOT' : state.roomCode}</b></div><div className={`timer ${seconds <= 10 ? 'danger' : ''}`}><small>TIME</small><strong>{String(seconds).padStart(2, '0')}<i>s</i></strong></div><div className="combo"><small>COMBO</small><b>× {me?.combo ?? 0}</b></div></div>
      <div className="scoreboard">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><span>{i + 1}</span><b>{p.nickname}</b><em>{p.score.toLocaleString()}</em></div>)}</div>
      <section className={`arena ${gameMode === 'shoot' ? 'shooting-arena' : ''}`}>
        <p className="arena-label">{gameMode === 'shoot' ? 'TRACK · TYPE · SHOOT!' : 'TYPE ONE & PRESS ENTER'}</p>
        <div className={`targets ${gameMode === 'shoot' ? 'shooting-targets' : ''}`}>{state.targets.map((target, i) => <article key={target.id} className={`${prefixMatches(target) ? 'matching' : ''} ${burstIndex === i ? 'bursting' : ''} target-${i} ${gameMode === 'shoot' ? `clay plate-${i}` : ''}`}><small>{target.points ?? 100} PTS</small><strong>{target.text}</strong><span>{input && prefixMatches(target) ? `${input.length}/${target.text.length}` : 'LOCK ON'}</span>{burstIndex === i && <div className="pixel-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, pixel) => <i key={pixel} style={{ '--pixel': pixel } as React.CSSProperties} />)}</div>}</article>)}</div>
        {gameMode === 'shoot' && <div className={`range-gun ${burstIndex !== null ? 'firing' : ''}`} aria-hidden="true"><i /><b>TYPE</b></div>}
        <form className={`type-form ${inputFeedback ? `is-${inputFeedback}` : ''}`} onSubmit={submit}><div className="prompt">›</div><input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder="단어를 입력하세요" autoComplete="off" autoCapitalize="none" enterKeyHint="send" spellCheck={false} aria-label="단어 입력" /><button>ENTER ↵</button></form>
        <p className="tip">화면의 단어를 정확히 입력하고 ENTER! 가장 먼저 보낸 사람이 점수를 얻어요.</p>
      </section>
      {effect === 'blur' && <div className="interference blurfx"><b>BLUR ATTACK!</b></div>}
      {effect === 'ink' && <div className="interference inkfx"><i /><i /><i /><b>INK ATTACK!</b></div>}
      {effect === 'shake' && <div className="interference shakefx"><b>SHAKE!</b></div>}
    </main>}

    {screen === 'result' && <main className="result">
      <p className="eyebrow">GAME CLEAR</p><h1>{sorted[0]?.id === playerId ? 'YOU WIN!' : 'NICE TRY!'}</h1>
      <div className="trophy">★</div><h2>{sorted[0]?.nickname}</h2><p className="final-score">{sorted[0]?.score.toLocaleString()} <small>PTS</small></p>
      <section className="results-table">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><strong>#{i + 1}</strong><span>{p.nickname}</span><b>{p.score.toLocaleString()}</b><em>MAX ×{p.combo}</em></div>)}</section>
      <div className="result-actions">{demo || state.hostId === playerId ? <><button className="primary" onClick={startGame}>한 판 더!</button><button className="ghost" onClick={returnToLobby}>대기실로</button></> : <><div className="waiting-host" role="status">방장의 선택을 기다리는 중…</div><button className="ghost" onClick={exitRoom}>나가기</button></>}</div>
    </main>}
    {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    <footer>© 20XX CATCH TYPING · BEST PLAYED WITH A KEYBOARD</footer>
  </div>
}

export default App
