import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientMessage, GameMode, MatchState, RoomSummary, ServerMessage, Target } from './protocol'
import { fromPublicRoom } from './protocol'
import { useGameSocket } from './useGameSocket'
import { playArcadeSound, type ArcadeSound } from './arcadeAudio'

type Screen = 'home' | 'hub' | 'lobby' | 'game' | 'result'
type Toast = { text: string; tone: 'good' | 'bad' | 'info' }
type InputFeedback = ArcadeSound | null
type ShotEffect = { x: number; y: number; length: number; angle: number }
const WORDS = ['번개', '스테이지', '콤보', '네온사인', '하이스코어', '동전', '보너스', '아케이드', '도전', '승부', '픽셀', '출발']
const MODE_INFO: Record<GameMode, { number: string; label: string; title: string; badge: string; description: string }> = {
  grab: { number: '01', label: '단어 쟁탈전', title: '네온 스트리트', badge: 'CATCH', description: '고정된 단어를 먼저 선점' },
  shoot: { number: '02', label: '접시 사격', title: '타이프 앤 슛', badge: 'SHOOT', description: '움직이는 접시를 타이핑으로 격추' },
  zombie: { number: '03', label: '좀비 디펜스', title: '라스트 키보드', badge: 'DEFEND', description: '다가오는 좀비를 함께 저지' },
  balloon: { number: '04', label: '풍선 팝', title: '벌룬 버스트', badge: 'POP', description: '떠오르는 풍선을 연쇄 폭발' },
  racing: { number: '05', label: '니트로 레이싱', title: '타입 레이서', badge: 'RACE', description: '짧은 가속과 긴 니트로를 선택' },
}
const demoTarget = (mode: GameMode, index: number): Target => {
  const now = Date.now()
  const motion = mode === 'zombie' ? { spawnedAt: now, expiresAt: now + 8500 + index * 650, kind: index % 5 === 3 ? 'armored' as const : index % 5 === 4 ? 'exploder' as const : 'normal' as const } : mode === 'balloon' ? { spawnedAt: now, expiresAt: now + 7000 + index * 500, kind: index === 4 ? 'giant' as const : index === 3 ? 'bomb' as const : index > 0 ? 'chain' as const : 'balloon' as const } : mode === 'racing' ? { kind: index === 4 ? 'nitro' as const : index > 1 ? 'corner' as const : 'speed' as const } : {}
  const word = WORDS[Math.floor(Math.random() * WORDS.length)] ?? WORDS[0]
  return { id: `demo-${index}-${now}-${Math.random()}`, text: mode === 'racing' && motion.kind === 'nitro' ? `${word} ${WORDS[(index + 6) % WORDS.length]}` : word, points: 100 + index * 20, ...motion }
}
const starterTargets = (mode: GameMode): Target[] => WORDS.slice(0, 5).map((text, i) => ({ ...demoTarget(mode, i), text }))
const roomFromUrl = () => new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) ?? ''
const emptyRoom = (): MatchState => ({ roomCode: '', mode: 'grab', phase: 'lobby', targets: [], players: [] })

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
  const [shotEffect, setShotEffect] = useState<ShotEffect | null>(null)
  const [reduced, setReduced] = useState(() => localStorage.getItem('reducedEffects') === 'true')
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('soundEnabled') !== 'false')
  const [demo, setDemo] = useState(false)
  const [gameMode, setGameMode] = useState<GameMode>('grab')
  const [selectedMode, setSelectedMode] = useState<GameMode>('grab')
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [createPickerOpen, setCreatePickerOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nicknameRef = useRef<HTMLInputElement>(null)
  const pendingRoomRef = useRef('')
  const viewportBaselineRef = useRef(0)
  const zombieDelayRef = useRef(new Map<string, number>())

  const triggerFeedback = useCallback((kind: ArcadeSound, targetId?: string) => {
    playArcadeSound(kind, soundEnabled, gameMode === 'shoot')
    setInputFeedback(kind)
    if (kind === 'success' && targetId) {
      const index = state.targets.findIndex(target => target.id === targetId)
      if (index >= 0) {
        setBurstIndex(index)
        if (gameMode === 'shoot') {
          const targetElement = [...document.querySelectorAll<HTMLElement>('[data-target-id]')].find(element => element.dataset.targetId === targetId)
          const rangeElement = targetElement?.closest<HTMLElement>('.shooting-targets')
          if (targetElement && rangeElement) {
            const targetRect = targetElement.getBoundingClientRect()
            const rangeRect = rangeElement.getBoundingClientRect()
            const x = targetRect.left - rangeRect.left + targetRect.width / 2
            const y = targetRect.top - rangeRect.top + targetRect.height / 2
            const originX = rangeRect.width / 2
            const originY = rangeRect.height + 10
            const deltaX = x - originX
            const deltaY = y - originY
            setShotEffect({ x, y, length: Math.hypot(deltaX, deltaY), angle: Math.atan2(deltaY, deltaX) * 180 / Math.PI })
          }
        }
      }
    }
    window.setTimeout(() => setInputFeedback(null), reduced ? 120 : 360)
    window.setTimeout(() => setBurstIndex(null), reduced ? 120 : 520)
    window.setTimeout(() => setShotEffect(null), reduced ? 140 : 720)
  }, [gameMode, reduced, soundEnabled, state.targets])

  const onServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === 'connected') {
      setPlayerId(message.playerId)
    } else if (message.type === 'room_list') {
      setRooms(message.rooms)
    } else if (message.type === 'room_left') {
      setState(emptyRoom())
      setScreen('hub')
    } else if (['room_created', 'room_joined', 'room_state', 'match_started', 'match_ended'].includes(message.type)) {
      const roomMessage = message as Extract<ServerMessage, { room: unknown }>
      const next = fromPublicRoom(roomMessage.room)
      setState(next)
      setGameMode(next.mode)
      setSelectedMode(next.mode)
      setCreatePickerOpen(false)
      setExpiredRoomCode('')
      setScreen(next.phase === 'playing' ? 'game' : next.phase === 'finished' ? 'result' : 'lobby')
      if (next.phase === 'playing') window.setTimeout(() => inputRef.current?.focus(), 50)
    } else if (message.type === 'submission_result') {
      if (message.playerId === playerId) {
        setToast(message.outcome === 'success' ? { text: `${gameMode === 'zombie' ? 'ZAP' : gameMode === 'shoot' ? 'BANG' : gameMode === 'balloon' ? message.scoreDelta < 0 ? 'BOMB' : 'POP' : 'CATCH'}! ${message.scoreDelta >= 0 ? '+' : ''}${message.scoreDelta}`, tone: message.scoreDelta < 0 ? 'bad' : 'good' } : message.outcome === 'claimed' ? { text: '한발 늦었어요!', tone: 'info' } : { text: 'MISS!', tone: 'bad' })
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
  }, [gameMode, playerId, reduced, triggerFeedback])
  const { status, connect, disconnect, send } = useGameSocket(onServerMessage)

  useEffect(() => { if (screen !== 'game' || state.phase !== 'playing') return; const tick = () => { const left = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)) : seconds; setSeconds(left); if (left === 0) setScreen('result') }; tick(); const id = window.setInterval(tick, 250); return () => clearInterval(id) }, [screen, state.endsAt, state.phase])
  useEffect(() => {
    if (!demo || screen !== 'game' || !['zombie', 'balloon'].includes(gameMode) || state.phase !== 'playing') return
    const id = window.setInterval(() => setState(current => {
      const now = Date.now(); const expired = current.targets.map((target, index) => target.expiresAt !== undefined && target.expiresAt <= now ? index : -1).filter(index => index >= 0)
      if (expired.length === 0) return current
      if (gameMode === 'balloon') return { ...current, targets: current.targets.map((target, index) => expired.includes(index) ? demoTarget('balloon', index) : target) }
      const damage = expired.reduce((total, index) => total + (current.targets[index].kind === 'exploder' ? 20 : current.targets[index].kind === 'armored' ? 14 : 10), 0)
      const baseHealth = Math.max(0, (current.modeState?.baseHealth ?? 100) - damage)
      return { ...current, targets: current.targets.map((target, index) => expired.includes(index) ? demoTarget('zombie', index) : target), modeState: { ...current.modeState, baseHealth } }
    }), 250)
    return () => window.clearInterval(id)
  }, [demo, gameMode, screen, state.phase])
  useEffect(() => { if (screen === 'game' && gameMode === 'zombie' && state.modeState?.baseHealth === 0) setScreen('result') }, [gameMode, screen, state.modeState?.baseHealth])
  useEffect(() => { if (screen === 'game' && gameMode === 'racing' && Object.values(state.modeState?.race ?? {}).some(racer => racer.distance >= (state.modeState?.trackLength ?? 100))) setScreen('result') }, [gameMode, screen, state.modeState?.race, state.modeState?.trackLength])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 900); return () => clearTimeout(id) }, [toast])
  useEffect(() => { localStorage.setItem('reducedEffects', String(reduced)) }, [reduced])
  useEffect(() => { localStorage.setItem('soundEnabled', String(soundEnabled)) }, [soundEnabled])
  useEffect(() => {
    if (!['home', 'hub'].includes(screen) || demo || status === 'connecting' || status === 'online') return
    const delay = status === 'offline' ? 2500 : 0
    const id = window.setTimeout(() => connect(), delay)
    return () => window.clearTimeout(id)
  }, [connect, demo, screen, status])
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
    if (status !== 'offline' || demo || screen === 'home' || screen === 'hub') return
    setToast({ text: '서버 연결이 끊어져 방에서 나왔어요', tone: 'bad' })
    setState(emptyRoom())
    setScreen('hub')
  }, [demo, screen, status])
  useEffect(() => {
    if (expiredRoomCode) disconnect()
  }, [disconnect, expiredRoomCode])

  const enterRoom = (mode: 'create' | 'join') => {
    if (!nickname.trim()) { setNicknameRequired(true); setToast({ text: 'STEP 1 · 닉네임을 먼저 입력해 주세요', tone: 'bad' }); nicknameRef.current?.focus(); return }
    if (mode === 'join' && roomInput.trim().length < 4) { setToast({ text: '방 코드를 확인해 주세요', tone: 'bad' }); return }
    setExpiredRoomCode('')
    pendingRoomRef.current = mode === 'join' ? roomInput.trim().toUpperCase() : ''
    const message: ClientMessage = mode === 'create' ? { type: 'create_room', name: nickname.trim(), mode: selectedMode } : { type: 'join_room', name: nickname.trim(), roomId: roomInput.trim().toUpperCase() }
    if (!send(message)) connect(message)
  }
  const enterHub = (event: FormEvent) => {
    event.preventDefault()
    if (!nickname.trim()) { setNicknameRequired(true); nicknameRef.current?.focus(); return }
    if (inviteRoomCode) { setRoomInput(inviteRoomCode); enterRoom('join'); return }
    setScreen('hub'); setExpiredRoomCode(''); send({ type: 'list_rooms' })
  }
  const joinListedRoom = (room: RoomSummary) => {
    if (!nickname.trim()) { setNicknameRequired(true); setToast({ text: '닉네임을 먼저 입력해 주세요', tone: 'bad' }); nicknameRef.current?.focus(); return }
    setRoomInput(room.id); setSelectedMode(room.mode); pendingRoomRef.current = room.id
    const message: ClientMessage = { type: 'join_room', name: nickname.trim(), roomId: room.id }
    if (!send(message)) connect(message)
  }
  const startDemo = (mode: GameMode = 'grab') => {
    setGameMode(mode); setDemo(true); setPlayerId('me'); setState({ roomCode: mode === 'shoot' ? 'RANGE' : mode === 'zombie' ? 'BASE01' : mode === 'balloon' ? 'POPPOP' : mode === 'racing' ? 'RACE01' : 'PIXEL', mode, phase: 'lobby', targets: [], modeState: mode === 'zombie' ? { baseHealth: 100, wave: 1, teamKills: 0 } : mode === 'racing' ? { trackLength: 100, race: { me: { distance: 0, nitro: 0 }, bot: { distance: 0, nitro: 0 } } } : undefined, players: [{ id: 'me', nickname: nickname.trim() || 'PLAYER 1', score: 0, combo: 0 }, { id: 'bot', nickname: mode === 'zombie' ? 'MEDIC.K' : mode === 'balloon' ? 'BUBBLE.K' : mode === 'racing' ? 'TURBO.K' : 'TURBO.K', score: 0, combo: 0 }] }); setScreen('lobby')
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
    if (screen === 'home') return
    if (screen === 'hub') { setScreen('home'); return }
    if (!demo) send({ type: 'leave_room' })
    setDemo(false)
    setGameMode('grab')
    setState(emptyRoom())
    setScreen('hub')
  }
  const startGame = () => {
    if (!demo) {
      if (!send({ type: 'start_match' })) setToast({ text: '서버에 연결되어 있지 않아요', tone: 'bad' })
      return
    }
    const now = Date.now(); setSeconds(60); setState(s => ({ ...s, phase: 'playing', targets: starterTargets(gameMode), modeState: gameMode === 'zombie' ? { baseHealth: 100, wave: 1, teamKills: 0 } : gameMode === 'racing' ? { trackLength: 100, race: Object.fromEntries(s.players.map(player => [player.id, { distance: 0, nitro: 0 }])) } : undefined, endsAt: now + 60000, durationMs: 60000 })); setScreen('game'); window.setTimeout(() => inputRef.current?.focus(), 50)
  }
  const chooseLobbyMode = (mode: GameMode) => {
    if (demo) { setGameMode(mode); setState(s => ({ ...s, mode })); return }
    if (state.hostId === playerId) send({ type: 'set_mode', mode })
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
    const me = state.players.find(p => p.id === playerId)!; const nextCombo = target.kind === 'bomb' ? 0 : me.combo + 1
    const scoreDelta = gameMode === 'racing' ? target.kind === 'nitro' ? 180 : target.kind === 'corner' ? 130 : 100 : target.kind === 'bomb' ? -100 : target.kind === 'giant' ? 250 : target.kind === 'chain' ? 150 : target.points ?? 100
    setState(s => {
      let modeState = gameMode === 'zombie' ? { ...s.modeState, teamKills: (s.modeState?.teamKills ?? 0) + 1, wave: 1 + Math.floor(((s.modeState?.teamKills ?? 0) + 1) / 8), baseHealth: nextCombo % 3 === 0 ? Math.min(100, (s.modeState?.baseHealth ?? 100) + 5) : s.modeState?.baseHealth ?? 100 } : s.modeState
      if (gameMode === 'racing') {
        const race = { ...s.modeState?.race }; const racer = { ...(race[playerId] ?? { distance: 0, nitro: 0 }) }; const charged = Math.min(100, racer.nitro + (target.kind === 'nitro' ? 38 : target.kind === 'corner' ? 12 : 8)); const boost = charged >= 100 ? 18 : 0
        racer.distance = Math.min(100, racer.distance + (target.kind === 'nitro' ? 14 : target.kind === 'corner' ? 11 : 8) + boost); racer.nitro = boost ? 0 : charged; race[playerId] = racer; modeState = { ...s.modeState, trackLength: 100, race }
      }
      return { ...s, targets: s.targets.map((t, index) => t.id === target.id ? demoTarget(gameMode, index) : t), modeState, players: s.players.map(p => p.id === playerId ? { ...p, score: p.score + scoreDelta, combo: nextCombo } : p) }
    })
    setToast({ text: target.kind === 'bomb' ? 'BOMB! -100' : `${gameMode === 'zombie' ? 'ZAP!' : gameMode === 'balloon' ? 'POP!' : 'CATCH!'} +${scoreDelta}`, tone: target.kind === 'bomb' ? 'bad' : 'good' }); triggerFeedback(target.kind === 'bomb' ? 'miss' : 'success', target.id); setInput('')
    if ([5, 8, 12].includes(nextCombo)) { setEffect(nextCombo >= 12 ? 'ink' : nextCombo >= 8 ? 'blur' : 'shake'); window.setTimeout(() => setEffect(null), reduced ? 250 : 900) }
  }

  const sorted = useMemo(() => [...state.players].sort((a, b) => gameMode === 'racing' ? (state.modeState?.race?.[b.id]?.distance ?? 0) - (state.modeState?.race?.[a.id]?.distance ?? 0) || b.score - a.score : b.score - a.score), [gameMode, state.modeState?.race, state.players])
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
        <div className="cabinet-marquee">PLAYER CHECK IN</div>
        <form className="cabinet-screen check-in" onSubmit={enterHub}>
          <div className="status-line"><span>{inviteRoomCode ? 'ROOM INVITATION' : 'ENTER THE ARCADE'}</span><b className={hasNickname ? 'ready' : 'required'}>{hasNickname ? '● READY' : '○ NAME REQUIRED'}</b></div>
          {expiredRoomCode && <div className="expired-room" role="alert"><strong>ROOM {expiredRoomCode} 종료됨</strong><span>이미 없어졌거나 만료된 방이에요.<br />공개 로비에서 다른 방을 찾아보세요.</span><button type="button" onClick={() => setExpiredRoomCode('')} aria-label="안내 닫기">×</button></div>}
          {inviteRoomCode && <div className="invite-ticket"><small>INVITED TO</small><strong>ROOM {inviteRoomCode}</strong><span>닉네임을 입력하면 바로 참가해요.</span></div>}
          <label>플레이어 닉네임<input ref={nicknameRef} maxLength={12} value={nickname} onChange={e => { setNickname(e.target.value); setNicknameRequired(false) }} placeholder="이름을 입력하세요" autoComplete="nickname" aria-invalid={nicknameRequired} autoFocus /></label>
          {nicknameRequired && <p className="field-error" role="alert">사용할 닉네임을 입력해 주세요.</p>}
          <button className="primary check-in-button">{inviteRoomCode ? `${inviteRoomCode} 방 참가` : '공개 로비 입장'} <kbd>↵</kbd></button>
          {inviteRoomCode && <button type="button" className="demo-link" onClick={leaveInvite}>초대를 취소하고 공개 로비로 →</button>}
        </form>
        <div className="cabinet-controls"><i /><i /><span /></div>
      </section>
      <div className="how"><span>01 닉네임 입력</span><b>→</b><span>02 방 선택</span><b>→</b><span>03 타이핑!</span></div>
    </main>}

    {screen === 'hub' && <main className="hub">
      <header className="hub-heading"><div><p className="eyebrow">ONLINE ARCADE</p><h1>공개 <span>대기실</span></h1><p>참가할 방을 고르거나 새로운 게임을 시작하세요.</p></div><button className="player-chip" onClick={() => setScreen('home')}><i>{nickname.charAt(0)}</i><span><small>PLAYER</small><b>{nickname}</b></span><em>변경</em></button></header>
      {expiredRoomCode && <div className="expired-room hub-expired" role="alert"><strong>ROOM {expiredRoomCode} 종료됨</strong><span>이미 없어졌거나 만료된 방이에요. 다른 방을 선택해 주세요.</span><button onClick={() => setExpiredRoomCode('')} aria-label="안내 닫기">×</button></div>}
      <section className="hub-actions">
        <div className="create-room-card"><small>NEW GAME</small><h2>새 방 만들기</h2><p>게임을 선택하고 친구를 초대하세요.</p><button className="primary" onClick={() => setCreatePickerOpen(true)}>+ 방 만들기</button></div>
        <div className="code-room-card"><small>ROOM CODE</small><h2>코드로 참가</h2><p>친구에게 받은 6자리 코드를 입력하세요.</p><div className="join-row"><input maxLength={6} value={roomInput} onChange={e => { setRoomInput(e.target.value.toUpperCase()); setExpiredRoomCode('') }} placeholder="예: A1B2C3" /><button onClick={() => enterRoom('join')}>참가</button></div></div>
      </section>
      {createPickerOpen && <section className="create-picker" role="dialog" aria-modal="true" aria-labelledby="create-picker-title"><div className="create-picker-panel"><div className="create-picker-head"><div><small>SELECT GAME</small><h2 id="create-picker-title">어떤 게임을 할까요?</h2></div><button onClick={() => setCreatePickerOpen(false)} aria-label="방 만들기 닫기">×</button></div><div className="game-picker" aria-label="게임 선택">{(['grab', 'shoot', 'zombie', 'balloon', 'racing'] as GameMode[]).map(mode => <button key={mode} className={selectedMode === mode ? 'selected' : ''} onClick={() => setSelectedMode(mode)}><i>{MODE_INFO[mode].number}</i><strong>{MODE_INFO[mode].label}</strong><small>{MODE_INFO[mode].description}</small></button>)}</div><button className="primary create-confirm" onClick={() => enterRoom('create')}>{MODE_INFO[selectedMode].label} 방 만들기 <kbd>↵</kbd></button></div></section>}
      <section className="public-rooms"><div className="public-rooms-head"><div><small>NOW WAITING</small><h2>참가 가능한 방 <span>{rooms.length}</span></h2></div><div className={`connection ${status}`}>● {status === 'online' ? '실시간 연결됨' : '서버 연결 중'}</div><button onClick={() => send({ type: 'list_rooms' })}>↻ 새로고침</button></div><div className="public-room-list">{rooms.length === 0 ? <div className="empty-rooms"><strong>아직 열린 방이 없어요</strong><span>첫 번째 방을 만들어 친구를 초대해 보세요.</span></div> : rooms.map(room => <button className="public-room" key={room.id} onClick={() => joinListedRoom(room)}><span className={`mode-badge ${room.mode}`}>{MODE_INFO[room.mode].badge}</span><span className="public-room-info"><b>{MODE_INFO[room.mode].label}</b><small>{room.hostName}의 방 · {room.id}</small></span><em>{room.playerCount}/{room.maxPlayers}</em><strong>참가 →</strong></button>)}</div></section>
      <section className="practice-strip"><span><small>SOLO TRAINING</small><b>먼저 혼자 연습해 볼까요?</b></span><div>{(['grab', 'shoot', 'zombie', 'balloon', 'racing'] as GameMode[]).map(mode => <button key={mode} onClick={() => startDemo(mode)}>{MODE_INFO[mode].label}</button>)}</div></section>
    </main>}

    {screen === 'lobby' && <main className="lobby">
      <p className="eyebrow">NOW ENTERING</p><h1>{MODE_INFO[gameMode].title} <span>{MODE_INFO[gameMode].number}</span></h1>
      <section className="room-panel">
        <div><small>ROOM CODE</small><button className="room-code" onClick={() => navigator.clipboard?.writeText(state.roomCode)}>{state.roomCode} <span>⧉</span></button><button className="invite-link" onClick={copyInviteLink}>⌁ 초대 링크 복사</button><p>친구는 링크를 열고 닉네임만 입력하면 참가할 수 있어요.</p></div>
        <div className={`connection ${demo ? 'demo' : status}`}>● {demo ? '연습 모드' : status === 'online' ? '서버 연결됨' : '연결 확인 중'}</div>
      </section>
      <section className="lobby-mode"><div><small>SELECTED GAME</small><strong>{MODE_INFO[gameMode].label}</strong><span>{state.hostId === playerId || demo ? '방장은 시작 전까지 변경할 수 있어요' : '방장이 선택한 게임으로 진행해요'}</span></div><div className="lobby-mode-buttons">{(['grab', 'shoot', 'zombie', 'balloon', 'racing'] as GameMode[]).map(mode => <button key={mode} className={gameMode === mode ? 'selected' : ''} disabled={!demo && state.hostId !== playerId} onClick={() => chooseLobbyMode(mode)}>{MODE_INFO[mode].number} {MODE_INFO[mode].badge}</button>)}</div></section>
      <section className="players"><div className="section-title"><h2>PLAYERS</h2><span>{state.players.length} / 5</span></div>{state.players.map((p, i) => <div className="player-slot" key={p.id}><strong>P{i + 1}</strong><div className={`avatar a${i + 1}`}>{p.nickname.charAt(0)}</div><span>{p.nickname}</span><i>READY</i></div>)}{Array.from({ length: Math.max(0, 5 - state.players.length) }, (_, i) => <div className="player-slot empty" key={i}><strong>?</strong><div className="avatar">+</div><span>친구를 기다리는 중...</span><i>WAIT</i></div>)}</section>
      <div className="lobby-actions"><button className="ghost" onClick={exitRoom}>← 나가기</button>{demo || state.hostId === playerId ? <button className="primary big" onClick={startGame}>게임 시작 <span>READY?</span></button> : <div className="waiting-host" role="status">방장이 게임을 시작하기를 기다리는 중…</div>}</div>
    </main>}

    {screen === 'game' && <main className={`game mode-${gameMode} feedback-${inputFeedback ?? 'idle'}`} onClick={() => inputRef.current?.focus()}>
      <div className="game-hud"><div><small>{gameMode === 'grab' ? 'ROOM' : 'MODE'}</small><b>{gameMode === 'grab' ? state.roomCode : MODE_INFO[gameMode].title.toUpperCase()}</b></div><div className={`timer ${seconds <= 10 ? 'danger' : ''}`}><small>TIME</small><strong>{String(seconds).padStart(2, '0')}<i>s</i></strong></div><div className="combo"><small>COMBO</small><b>× {me?.combo ?? 0}</b></div></div>
      <div className="scoreboard">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><span>{i + 1}</span><b>{p.nickname}</b><em>{p.score.toLocaleString()}</em></div>)}</div>
      <section className={`arena ${gameMode === 'shoot' ? 'shooting-arena' : gameMode === 'zombie' ? 'zombie-arena' : gameMode === 'balloon' ? 'balloon-arena' : gameMode === 'racing' ? 'racing-arena' : ''}`}>
        <p className="arena-label">{gameMode === 'shoot' ? 'TRACK · TYPE · SHOOT!' : gameMode === 'zombie' ? 'DEFEND THE LAST KEYBOARD!' : gameMode === 'balloon' ? 'TYPE · POP · CHAIN!' : gameMode === 'racing' ? 'TYPE · BOOST · OVERTAKE!' : 'TYPE ONE & PRESS ENTER'}</p>
        {gameMode === 'zombie' && <div className="zombie-status"><div><small>BASE CORE</small><strong>{state.modeState?.baseHealth ?? 100}%</strong></div><span className="health-track"><i style={{ width: `${state.modeState?.baseHealth ?? 100}%` }} /></span><div><small>WAVE</small><strong>{state.modeState?.wave ?? 1}</strong></div><div><small>ZAPS</small><strong>{state.modeState?.teamKills ?? 0}</strong></div></div>}
        {gameMode === 'racing' && <div className="race-track">{state.players.map((player, index) => { const racer = state.modeState?.race?.[player.id] ?? { distance: 0, nitro: 0 }; return <div className={`race-lane ${player.id === playerId ? 'mine' : ''}`} key={player.id}><b>{player.nickname}</b><span className="road"><i className={`race-car car-${index}`} style={{ '--race-progress': `${racer.distance}%` } as React.CSSProperties}>▰</i><em>FINISH</em></span><small>{Math.round(racer.distance)}m</small><span className="nitro-meter"><i style={{ width: `${racer.nitro}%` }} />NITRO {Math.round(racer.nitro)}%</span></div> })}</div>}
        <div className={`targets ${gameMode === 'shoot' ? 'shooting-targets' : gameMode === 'zombie' ? 'zombie-targets' : gameMode === 'balloon' ? 'balloon-targets' : gameMode === 'racing' ? 'racing-targets' : ''}`}>{state.targets.map((target, i) => {
          let zombieStyle: React.CSSProperties | undefined
          if (gameMode === 'zombie' || gameMode === 'balloon') {
            const spawnedAt = target.spawnedAt ?? Date.now()
            if (!zombieDelayRef.current.has(target.id)) zombieDelayRef.current.set(target.id, Math.max(0, Date.now() - spawnedAt))
            zombieStyle = { '--zombie-duration': `${Math.max(1000, (target.expiresAt ?? spawnedAt + 8000) - spawnedAt)}ms`, '--zombie-delay': `-${zombieDelayRef.current.get(target.id) ?? 0}ms` } as React.CSSProperties
          }
          return <article key={target.id} data-target-id={target.id} style={zombieStyle} className={`${prefixMatches(target) ? 'matching' : ''} ${burstIndex === i ? 'bursting' : ''} target-${i} ${gameMode === 'shoot' ? `clay plate-${i}` : gameMode === 'zombie' ? `zombie zombie-${target.kind ?? 'normal'}` : gameMode === 'balloon' ? `balloon balloon-${target.kind ?? 'balloon'}` : gameMode === 'racing' ? `race-target race-${target.kind ?? 'speed'}` : ''}`}><small>{target.kind === 'armored' ? 'ARMORED' : target.kind === 'exploder' ? 'BOOMER' : target.kind === 'bomb' ? '☠ BOMB -100' : target.kind === 'giant' ? '★ GIANT 250' : target.kind === 'chain' ? '◇ CHAIN 150' : target.kind === 'nitro' ? '⚡ NITRO +14m' : target.kind === 'corner' ? '↪ CORNER +11m' : target.kind === 'speed' ? '» SPEED +8m' : `${target.points ?? 100} PTS`}</small><strong>{target.text}</strong><span>{input && prefixMatches(target) ? `${input.length}/${target.text.length}` : gameMode === 'zombie' ? 'TYPE TO ZAP' : gameMode === 'balloon' ? 'POP!' : gameMode === 'racing' ? 'SHIFT UP' : 'LOCK ON'}</span>{burstIndex === i && gameMode !== 'shoot' && <div className="pixel-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, pixel) => <i key={pixel} style={{ '--pixel': pixel } as React.CSSProperties} />)}</div>}</article>
        })}{gameMode === 'shoot' && shotEffect && <div className="shot-effect" aria-hidden="true" style={{ '--impact-x': `${shotEffect.x}px`, '--impact-y': `${shotEffect.y}px`, '--shot-length': `${shotEffect.length}px`, '--shot-angle': `${shotEffect.angle}deg` } as React.CSSProperties}><i className="bullet-trail" /><i className="impact-flash" /><b>BANG!</b><span className="clay-shards">{Array.from({ length: 14 }, (_, shard) => <i key={shard} style={{ '--shard': shard, '--fall-x': `${((shard * 37) % 150) - 75}px` } as React.CSSProperties} />)}</span></div>}</div>
        {gameMode === 'zombie' && <div className="last-keyboard" aria-hidden="true"><i /><b>LAST<br />KEYBOARD</b><span>⌨</span></div>}
        {gameMode === 'shoot' && <div className={`range-gun ${shotEffect ? 'firing' : ''}`} aria-hidden="true"><i /><b>TYPE</b></div>}
        <form className={`type-form ${inputFeedback ? `is-${inputFeedback}` : ''}`} onSubmit={submit}><div className="prompt">›</div><input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder="단어를 입력하세요" autoComplete="off" autoCapitalize="none" enterKeyHint="send" spellCheck={false} aria-label="단어 입력" /><button>ENTER ↵</button></form>
        <p className="tip">화면의 단어를 정확히 입력하고 ENTER! 가장 먼저 보낸 사람이 점수를 얻어요.</p>
      </section>
      {effect === 'blur' && <div className="interference blurfx"><b>BLUR ATTACK!</b></div>}
      {effect === 'ink' && <div className="interference inkfx"><i /><i /><i /><b>INK ATTACK!</b></div>}
      {effect === 'shake' && <div className="interference shakefx"><b>SHAKE!</b></div>}
    </main>}

    {screen === 'result' && <main className="result">
      <p className="eyebrow">{gameMode === 'zombie' && state.modeState?.baseHealth === 0 ? 'BASE DESTROYED' : 'GAME CLEAR'}</p><h1>{gameMode === 'zombie' ? state.modeState?.baseHealth === 0 ? 'DEFENSE FAILED!' : 'BASE SECURED!' : sorted[0]?.id === playerId ? 'YOU WIN!' : 'NICE TRY!'}</h1>
      <div className="trophy">{gameMode === 'zombie' && state.modeState?.baseHealth === 0 ? '×' : '★'}</div><h2>{gameMode === 'zombie' ? `TEAM ZAPS ${state.modeState?.teamKills ?? 0}` : sorted[0]?.nickname}</h2><p className="final-score">{sorted[0]?.score.toLocaleString()} <small>PTS</small></p>
      <section className="results-table">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><strong>#{i + 1}</strong><span>{p.nickname}</span><b>{p.score.toLocaleString()}</b><em>MAX ×{p.combo}</em></div>)}</section>
      <div className="result-actions">{demo || state.hostId === playerId ? <><button className="primary" onClick={startGame}>한 판 더!</button><button className="ghost" onClick={returnToLobby}>대기실로</button></> : <><div className="waiting-host" role="status">방장의 선택을 기다리는 중…</div><button className="ghost" onClick={exitRoom}>나가기</button></>}</div>
    </main>}
    {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    <footer>© 20XX CATCH TYPING · BEST PLAYED WITH A KEYBOARD</footer>
  </div>
}

export default App
