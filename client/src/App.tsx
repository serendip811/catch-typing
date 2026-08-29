import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientMessage, GameMode, MatchState, RoomSummary, ServerMessage, Target } from './protocol'
import { fromPublicRoom } from './protocol'
import { useGameSocket } from './useGameSocket'
import { playArcadeSound, type ArcadeSound } from './arcadeAudio'

type Screen = 'home' | 'hub' | 'lobby' | 'game' | 'result'
type Toast = { text: string; tone: 'good' | 'bad' | 'info' }
type InputFeedback = ArcadeSound | null
type ShotEffect = { x: number; y: number; length: number; angle: number }
const WORDS = [
  '번개', '퇴근까지 조금만 더', '네온사인', '우산 챙기는 걸 깜빡했다', '하이스코어',
  '빠르고 정확하게 입력하세요', '보물상자가 나타났다', '마지막 판이라고 했는데', '콤보를 계속 이어가자',
  '스테이지', '동전', '보너스', '아케이드', '도전', '승부', '픽셀', '출발',
]
const MODE_INFO: Record<GameMode, { number: string; label: string; title: string; badge: string; description: string }> = {
  grab: { number: '01', label: '단어 쟁탈전', title: '네온 스트리트', badge: 'CATCH', description: '고정된 단어를 먼저 선점' },
  shoot: { number: '02', label: '접시 사격', title: '타이프 앤 슛', badge: 'SHOOT', description: '움직이는 접시를 타이핑으로 격추' },
  zombie: { number: '03', label: '좀비 디펜스', title: '라스트 키보드', badge: 'DEFEND', description: '다가오는 좀비를 함께 저지' },
  balloon: { number: '04', label: '풍선 팝', title: '벌룬 버스트', badge: 'POP', description: '떠오르는 풍선을 연쇄 폭발' },
  racing: { number: '05', label: '니트로 레이싱', title: '타입 레이서', badge: 'RACE', description: '짧은 가속과 긴 니트로를 선택' },
  treasure: { number: '06', label: '보물 사냥', title: '트레저 타입', badge: 'LOOT', description: '상자를 열어 열쇠와 보물을 발견' },
  crown: { number: '07', label: '왕관 지키기', title: '크라운 키퍼', badge: 'CROWN', description: '왕관을 빼앗고 오래 지켜 점수 획득' },
}
const demoTarget = (mode: GameMode, index: number): Target => {
  const now = Date.now()
  const motion = mode === 'shoot' ? { spawnedAt: now, expiresAt: now + (index % 3 === 1 ? 4600 : index % 3 === 2 ? 7400 : 6200), kind: index % 3 === 1 ? 'fast' as const : index % 3 === 2 ? 'gold' as const : 'normal' as const } : mode === 'zombie' ? { spawnedAt: now, expiresAt: now + 8500 + index * 650, kind: index % 5 === 3 ? 'armored' as const : index % 5 === 4 ? 'exploder' as const : 'normal' as const } : mode === 'balloon' ? { spawnedAt: now, expiresAt: now + 7000 + index * 500, kind: index === 4 ? 'giant' as const : index === 3 ? 'bomb' as const : index > 0 ? 'chain' as const : 'balloon' as const } : mode === 'racing' ? { kind: index === 4 ? 'nitro' as const : index > 1 ? 'corner' as const : 'speed' as const } : mode === 'treasure' ? { kind: index === 0 ? 'key' as const : index === 1 ? 'vault' as const : index === 2 ? 'map' as const : index === 3 ? 'trap' as const : 'chest' as const } : mode === 'crown' ? { kind: index === 0 ? 'crown' as const : 'guard' as const } : {}
  const word = WORDS[Math.floor(Math.random() * WORDS.length)] ?? WORDS[0]
  const text = mode === 'racing' && motion.kind === 'nitro' ? `${word} ${WORDS[(index + 6) % WORDS.length]} ${WORDS[(index + 9) % WORDS.length]}` : (mode === 'shoot' && motion.kind === 'gold') || (mode === 'racing' && motion.kind === 'corner') || (mode === 'treasure' && motion.kind === 'vault') || (mode === 'zombie' && motion.kind === 'armored') || (mode === 'balloon' && motion.kind === 'giant') ? `${word} ${WORDS[(index + 6) % WORDS.length]}` : word
  const points = mode === 'shoot' ? motion.kind === 'gold' ? 250 : motion.kind === 'fast' ? 160 : 100 : mode === 'zombie' ? motion.kind === 'exploder' ? 200 : motion.kind === 'armored' ? 180 : 100 : mode === 'racing' ? motion.kind === 'nitro' ? 220 : motion.kind === 'corner' ? 140 : 100 : mode === 'treasure' ? motion.kind === 'vault' ? 400 : motion.kind === 'map' ? 120 : motion.kind === 'key' ? 80 : motion.kind === 'trap' ? -80 : 100 : mode === 'balloon' ? motion.kind === 'bomb' ? -100 : motion.kind === 'giant' ? 250 : motion.kind === 'chain' ? 150 : 100 : 100 + index * 20
  return { id: `demo-${index}-${now}-${Math.random()}`, text, points, ...motion }
}
const starterTargets = (mode: GameMode): Target[] => WORDS.slice(0, 5).map((text, i) => { const target = demoTarget(mode, i); const targetText = mode === 'zombie' && target.kind === 'armored' ? `${text} ${WORDS[(i + 6) % WORDS.length]}` : mode === 'racing' && target.kind === 'nitro' ? `${text} ${WORDS[(i + 6) % WORDS.length]} ${WORDS[(i + 9) % WORDS.length]}` : (mode === 'shoot' && target.kind === 'gold') || (mode === 'racing' && target.kind === 'corner') || (mode === 'balloon' && target.kind === 'giant') ? `${text} ${WORDS[(i + 6) % WORDS.length]}` : text; return { ...target, text: targetText } })
const roomFromUrl = () => new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) ?? ''
const emptyRoom = (): MatchState => ({ roomCode: '', mode: 'grab', phase: 'lobby', targets: [], players: [], spectators: [] })

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
  const keyboardViewportHeightRef = useRef<number | null>(null)
  const zombieDelayRef = useRef(new Map<string, number>())
  const baseHealthRef = useRef(100)

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
      if (next.mode === 'zombie') {
        const nextHealth = next.modeState?.baseHealth ?? 100
        if (next.phase === 'playing' && nextHealth < baseHealthRef.current) {
          const damage = baseHealthRef.current - nextHealth
          setEffect('shake'); window.setTimeout(() => setEffect(null), reduced ? 180 : 520)
          setToast({ text: `기지 피격! -${damage}`, tone: 'bad' })
        }
        baseHealthRef.current = nextHealth
      } else {
        baseHealthRef.current = 100
      }
      setState(next)
      setGameMode(next.mode)
      setSelectedMode(next.mode)
      setCreatePickerOpen(false)
      setExpiredRoomCode('')
      setScreen(next.phase === 'playing' ? 'game' : next.phase === 'finished' ? 'result' : 'lobby')
      if (next.phase === 'playing' && !next.spectators.some(spectator => spectator.id === playerId)) window.setTimeout(() => inputRef.current?.focus(), 50)
    } else if (message.type === 'submission_result') {
      if (message.playerId === playerId) {
        const submittedTarget = state.targets.find(target => target.id === message.targetId)
        const successLabel = gameMode === 'zombie' ? 'ZAP' : gameMode === 'shoot' ? 'BANG' : gameMode === 'balloon' ? message.scoreDelta < 0 ? 'BOMB' : 'POP' : gameMode === 'racing' ? 'BOOST' : gameMode === 'crown' ? submittedTarget?.kind === 'crown' ? '왕관 획득' : '방어 성공' : 'CATCH'
        setToast(message.outcome === 'success' ? { text: `${successLabel}! ${message.scoreDelta >= 0 ? '+' : ''}${message.scoreDelta}`, tone: message.scoreDelta < 0 ? 'bad' : 'good' } : message.outcome === 'claimed' ? { text: '한발 늦었어요!', tone: 'info' } : { text: gameMode === 'crown' ? '지금은 입력할 수 없는 단어예요' : gameMode === 'racing' ? 'MISS! 속도 -2m' : 'MISS!', tone: 'bad' })
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
  }, [gameMode, playerId, reduced, state.targets, triggerFeedback])
  const { status, connect, disconnect, send } = useGameSocket(onServerMessage)

  useEffect(() => { if (screen !== 'game' || state.phase !== 'playing') return; const tick = () => { const left = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)) : seconds; setSeconds(left); if (left === 0) setScreen('result') }; tick(); const id = window.setInterval(tick, 250); return () => clearInterval(id) }, [screen, state.endsAt, state.phase])
  useEffect(() => {
    if (!demo || screen !== 'game' || !['shoot', 'zombie', 'balloon'].includes(gameMode) || state.phase !== 'playing') return
    const id = window.setInterval(() => setState(current => {
      const now = Date.now(); const expired = current.targets.map((target, index) => target.expiresAt !== undefined && target.expiresAt <= now ? index : -1).filter(index => index >= 0)
      if (expired.length === 0) return current
      if (gameMode === 'shoot' || gameMode === 'balloon') return { ...current, targets: current.targets.map((target, index) => expired.includes(index) ? demoTarget(gameMode, index) : target) }
      const damage = expired.reduce((total, index) => total + (current.targets[index].kind === 'exploder' ? 25 : current.targets[index].kind === 'armored' ? 18 : 10), 0)
      const baseHealth = Math.max(0, (current.modeState?.baseHealth ?? 100) - damage)
      return { ...current, targets: current.targets.map((target, index) => expired.includes(index) ? demoTarget('zombie', index) : target), modeState: { ...current.modeState, baseHealth } }
    }), 250)
    return () => window.clearInterval(id)
  }, [demo, gameMode, screen, state.phase])
  useEffect(() => { if (screen === 'game' && gameMode === 'zombie' && state.modeState?.baseHealth === 0) setScreen('result') }, [gameMode, screen, state.modeState?.baseHealth])
  useEffect(() => { if (screen === 'game' && gameMode === 'racing' && Object.values(state.modeState?.race ?? {}).some(racer => racer.distance >= (state.modeState?.trackLength ?? 100))) setScreen('result') }, [gameMode, screen, state.modeState?.race, state.modeState?.trackLength])
  useEffect(() => {
    if (!demo || screen !== 'game' || gameMode !== 'crown' || state.phase !== 'playing') return
    const id = window.setInterval(() => setState(current => {
      const crown = current.modeState?.crown
      if (!crown?.holderId) return current
      const heldMs = { ...crown.heldMs, [crown.holderId]: (crown.heldMs[crown.holderId] ?? 0) + 1000 }
      return { ...current, modeState: { ...current.modeState, crown: { ...crown, heldMs } }, players: current.players.map(player => player.id === crown.holderId ? { ...player, score: player.score + 10 * Math.max(1, crown.streak) } : player) }
    }), 1000)
    return () => clearInterval(id)
  }, [demo, gameMode, screen, state.phase])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 900); return () => clearTimeout(id) }, [toast])
  useEffect(() => { localStorage.setItem('reducedEffects', String(reduced)) }, [reduced])
  useEffect(() => { localStorage.setItem('soundEnabled', String(soundEnabled)) }, [soundEnabled])
  useEffect(() => {
    document.body.classList.toggle('game-keyboard-open', keyboardOpen)
    return () => document.body.classList.remove('game-keyboard-open')
  }, [keyboardOpen])
  useEffect(() => {
    if (screen !== 'game' || !inputRef.current) return
    const gameInput = inputRef.current
    gameInput.setAttribute('autocomplete', 'one-time-code')
    gameInput.setAttribute('autocorrect', 'off')
    gameInput.setAttribute('autocapitalize', 'none')
    gameInput.setAttribute('aria-autocomplete', 'none')
    gameInput.setAttribute('data-1p-ignore', 'true')
    gameInput.setAttribute('data-lpignore', 'true')
    gameInput.name = 'arcade-answer'
  }, [screen])
  useEffect(() => {
    if (!createPickerOpen) return
    const scrollY = window.scrollY
    document.body.classList.add('modal-open')
    document.body.style.top = `-${scrollY}px`
    return () => {
      document.body.classList.remove('modal-open')
      document.body.style.top = ''
      window.scrollTo({ top: scrollY, behavior: 'auto' })
    }
  }, [createPickerOpen])
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
        if (open) {
          keyboardViewportHeightRef.current = Math.min(keyboardViewportHeightRef.current ?? viewport.height, viewport.height)
        } else {
          keyboardViewportHeightRef.current = null
        }
        const stableHeight = keyboardViewportHeightRef.current ?? viewport.height
        document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(stableHeight)}px`)
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
      keyboardViewportHeightRef.current = null
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
    setGameMode(mode); setDemo(true); setPlayerId('me'); setState({ roomCode: mode === 'shoot' ? 'RANGE' : mode === 'zombie' ? 'BASE01' : mode === 'balloon' ? 'POPPOP' : mode === 'racing' ? 'RACE01' : mode === 'treasure' ? 'LOOT01' : mode === 'crown' ? 'CROWN1' : 'PIXEL', mode, phase: 'lobby', targets: [], modeState: mode === 'zombie' ? { baseHealth: 100, wave: 1, teamKills: 0 } : mode === 'racing' ? { trackLength: 100, race: { me: { distance: 0, nitro: 0 }, bot: { distance: 0, nitro: 0 } } } : mode === 'treasure' ? { treasure: { me: { keys: 0, maps: 0 }, bot: { keys: 0, maps: 0 } } } : mode === 'crown' ? { crown: { streak: 0, heldMs: { me: 0, bot: 0 } } } : undefined, players: [{ id: 'me', nickname: nickname.trim() || 'PLAYER 1', score: 0, combo: 0 }, { id: 'bot', nickname: mode === 'zombie' ? 'MEDIC.K' : mode === 'balloon' ? 'BUBBLE.K' : mode === 'treasure' ? 'RUBY.K' : mode === 'crown' ? 'KING.K' : 'TURBO.K', score: 0, combo: 0 }], spectators: [] }); setScreen('lobby')
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
    const now = Date.now(); setSeconds(60); setState(s => ({ ...s, phase: 'playing', targets: starterTargets(gameMode), modeState: gameMode === 'zombie' ? { baseHealth: 100, wave: 1, teamKills: 0 } : gameMode === 'racing' ? { trackLength: 100, race: Object.fromEntries(s.players.map(player => [player.id, { distance: 0, nitro: 0 }])) } : gameMode === 'treasure' ? { treasure: Object.fromEntries(s.players.map(player => [player.id, { keys: 0, maps: 0 }])) } : gameMode === 'crown' ? { crown: { streak: 0, heldMs: Object.fromEntries(s.players.map(player => [player.id, 0])) } } : undefined, endsAt: now + 60000, durationMs: 60000 })); setScreen('game'); window.setTimeout(() => inputRef.current?.focus(), 50)
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
    const crownHolderId = state.modeState?.crown?.holderId
    const target = state.targets.find(candidate => candidate.text === text && !(gameMode === 'treasure' && candidate.kind === 'vault' && (state.modeState?.treasure?.[playerId]?.keys ?? 0) < 1) && (gameMode !== 'crown' || (candidate.kind === 'crown' ? crownHolderId !== playerId : candidate.kind === 'guard' ? crownHolderId === playerId : false)))
    if (!demo) {
      const sent = send({ type: 'submit', targetId: target?.id ?? 'no-matching-target', text })
      if (!sent) setToast({ text: '서버 연결을 확인해 주세요', tone: 'bad' })
      if (sent) setInput('')
      return
    }
    if (!target) { setToast({ text: 'MISS! 콤보가 끊겼어요', tone: 'bad' }); triggerFeedback('miss'); setState(s => ({ ...s, players: s.players.map(p => p.id === playerId ? { ...p, combo: 0 } : p) })); setInput(''); return }
    const me = state.players.find(p => p.id === playerId)!; const nextCombo = target.kind === 'bomb' || target.kind === 'trap' ? 0 : me.combo + 1
    let scoreDelta = gameMode === 'zombie' ? target.points ?? 100 : gameMode === 'racing' ? target.points ?? 100 : gameMode === 'treasure' ? target.kind === 'trap' ? -80 : target.kind === 'vault' ? (state.modeState?.treasure?.[playerId]?.keys ?? 0) > 0 ? 400 : 180 : target.kind === 'map' ? 120 : target.kind === 'key' ? 80 : 100 : gameMode === 'crown' ? target.kind === 'crown' ? 150 : 80 : target.kind === 'bomb' ? -100 : target.kind === 'giant' ? 250 : target.kind === 'chain' ? 150 : target.points ?? 100
    setState(s => {
      let modeState = gameMode === 'zombie' ? { ...s.modeState, teamKills: (s.modeState?.teamKills ?? 0) + 1, wave: 1 + Math.floor(((s.modeState?.teamKills ?? 0) + 1) / 8), baseHealth: nextCombo % 3 === 0 ? Math.min(100, (s.modeState?.baseHealth ?? 100) + 5) : s.modeState?.baseHealth ?? 100 } : s.modeState
      if (gameMode === 'racing') {
        const race = { ...s.modeState?.race }; const racer = { ...(race[playerId] ?? { distance: 0, nitro: 0 }) }; const charged = Math.min(100, racer.nitro + (target.kind === 'nitro' ? 38 : target.kind === 'corner' ? 12 : 8)); const boost = charged >= 100 ? 18 : 0
        racer.distance = Math.min(100, racer.distance + (target.kind === 'nitro' ? 14 : target.kind === 'corner' ? 11 : 8) + boost); racer.nitro = boost ? 0 : charged; race[playerId] = racer; modeState = { ...s.modeState, trackLength: 100, race }
      }
      if (gameMode === 'treasure') {
        const treasure = { ...s.modeState?.treasure }; const bag = { ...(treasure[playerId] ?? { keys: 0, maps: 0 }) }
        if (target.kind === 'key') bag.keys += 1
        if (target.kind === 'vault' && bag.keys > 0) bag.keys -= 1
        if (target.kind === 'map') { bag.maps += 1; if (bag.maps % 3 === 0) scoreDelta += 200 }
        treasure[playerId] = bag; modeState = { ...s.modeState, treasure }
      }
      if (gameMode === 'crown') {
        const crown = { ...(s.modeState?.crown ?? { streak: 0, heldMs: {} }), heldMs: { ...(s.modeState?.crown?.heldMs ?? {}) } }
        if (target.kind === 'crown') { crown.streak = crown.holderId === playerId ? Math.min(5, crown.streak + 1) : 1; crown.holderId = playerId }
        else if (crown.holderId === playerId) { crown.streak = Math.min(5, crown.streak + 1); scoreDelta += crown.streak * 20 }
        modeState = { ...s.modeState, crown }
      }
      return { ...s, targets: s.targets.map((t, index) => t.id === target.id ? demoTarget(gameMode, index) : t), modeState, players: s.players.map(p => p.id === playerId ? { ...p, score: p.score + scoreDelta, combo: nextCombo } : p) }
    })
    setToast({ text: target.kind === 'bomb' ? 'BOMB! -100' : target.kind === 'trap' ? 'TRAP! -80' : `${gameMode === 'zombie' ? 'ZAP!' : gameMode === 'balloon' ? 'POP!' : gameMode === 'racing' ? 'BOOST!' : gameMode === 'treasure' ? 'LOOT!' : gameMode === 'crown' ? target.kind === 'crown' ? '왕관 획득!' : '방어 성공!' : 'CATCH!'} +${scoreDelta}`, tone: target.kind === 'bomb' || target.kind === 'trap' ? 'bad' : 'good' }); triggerFeedback(target.kind === 'bomb' || target.kind === 'trap' ? 'miss' : 'success', target.id); setInput('')
    if ([5, 8, 12].includes(nextCombo)) { setEffect(nextCombo >= 12 ? 'ink' : nextCombo >= 8 ? 'blur' : 'shake'); window.setTimeout(() => setEffect(null), reduced ? 250 : 900) }
  }

  const sorted = useMemo(() => [...state.players].sort((a, b) => gameMode === 'racing' ? (state.modeState?.race?.[b.id]?.distance ?? 0) - (state.modeState?.race?.[a.id]?.distance ?? 0) || b.score - a.score : b.score - a.score), [gameMode, state.modeState?.race, state.players])
  const me = state.players.find(p => p.id === playerId) ?? sorted[0]
  const isSpectator = state.spectators.some(spectator => spectator.id === playerId)
  const crownHolderId = state.modeState?.crown?.holderId
  const crownHolder = state.players.find(player => player.id === crownHolderId)
  const isCrownHolder = crownHolderId === playerId
  const crownRate = 10 * Math.max(1, state.modeState?.crown?.streak ?? 0)
  const visibleTargetEntries = state.targets.map((target, index) => ({ target, index })).filter(({ target }) => gameMode !== 'crown' || isSpectator || (target.kind === 'crown' ? !isCrownHolder : target.kind === 'guard' ? isCrownHolder : false))
  const nearestZombieSeconds = gameMode === 'zombie' ? Math.min(...state.targets.map(target => Math.max(0, ((target.expiresAt ?? Date.now()) - Date.now()) / 1000))) : Infinity
  const myRacer = state.modeState?.race?.[playerId] ?? { distance: 0, nitro: 0 }
  const raceLeaderId = sorted[0]?.id
  const myRacePosition = Math.max(1, sorted.findIndex(player => player.id === playerId) + 1)
  const raceLeaderDistance = state.modeState?.race?.[raceLeaderId]?.distance ?? 0
  const raceGap = Math.max(0, raceLeaderDistance - myRacer.distance)
  const myTreasure = state.modeState?.treasure?.[playerId] ?? { keys: 0, maps: 0 }
  const chainBalloonCount = state.targets.filter(target => target.kind === 'chain').length
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
      {createPickerOpen && <section className="create-picker" role="dialog" aria-modal="true" aria-labelledby="create-picker-title"><div className="create-picker-panel"><div className="create-picker-head"><div><small>SELECT GAME</small><h2 id="create-picker-title">어떤 게임을 할까요?</h2></div><button onClick={() => setCreatePickerOpen(false)} aria-label="방 만들기 닫기">×</button></div><div className="game-picker" aria-label="게임 선택">{(['grab', 'shoot', 'zombie', 'balloon', 'racing', 'treasure', 'crown'] as GameMode[]).map(mode => <button key={mode} className={selectedMode === mode ? 'selected' : ''} onClick={() => setSelectedMode(mode)}><i>{MODE_INFO[mode].number}</i><strong>{MODE_INFO[mode].label}</strong><small>{MODE_INFO[mode].description}</small></button>)}</div><button className="primary create-confirm" onClick={() => enterRoom('create')}>{MODE_INFO[selectedMode].label} 방 만들기 <kbd>↵</kbd></button></div></section>}
      <section className="public-rooms"><div className="public-rooms-head"><div><small>LIVE ROOMS</small><h2>공개 게임방 <span>{rooms.length}</span></h2></div><div className={`connection ${status}`}>● {status === 'online' ? '실시간 연결됨' : '서버 연결 중'}</div><button onClick={() => send({ type: 'list_rooms' })}>↻ 새로고침</button></div><div className="public-room-list">{rooms.length === 0 ? <div className="empty-rooms"><strong>아직 열린 방이 없어요</strong><span>첫 번째 방을 만들어 친구를 초대해 보세요.</span></div> : rooms.map(room => <button className={`public-room ${room.status === 'playing' ? 'is-playing' : ''}`} key={room.id} onClick={() => joinListedRoom(room)}><span className={`mode-badge ${room.mode}`}>{MODE_INFO[room.mode].badge}</span><span className="public-room-info"><b>{MODE_INFO[room.mode].label}</b><small>{room.hostName}의 방 · {room.id}{room.spectatorCount > 0 ? ` · 관전 ${room.spectatorCount}` : ''}</small></span><em>{room.status === 'playing' ? '● 게임 중' : `${room.playerCount}/${room.maxPlayers}`}</em><strong>{room.status === 'playing' ? '관전 →' : '참가 →'}</strong></button>)}</div></section>
      <section className="practice-strip"><span><small>SOLO TRAINING</small><b>먼저 혼자 연습해 볼까요?</b></span><div>{(['grab', 'shoot', 'zombie', 'balloon', 'racing', 'treasure', 'crown'] as GameMode[]).map(mode => <button key={mode} onClick={() => startDemo(mode)}>{MODE_INFO[mode].label}</button>)}</div></section>
    </main>}

    {screen === 'lobby' && <main className="lobby">
      <p className="eyebrow">NOW ENTERING</p><h1>{MODE_INFO[gameMode].title} <span>{MODE_INFO[gameMode].number}</span></h1>
      <section className="room-panel">
        <div><small>ROOM CODE</small><button className="room-code" onClick={() => navigator.clipboard?.writeText(state.roomCode)}>{state.roomCode} <span>⧉</span></button><button className="invite-link" onClick={copyInviteLink}>⌁ 초대 링크 복사</button><p>친구는 링크를 열고 닉네임만 입력하면 참가할 수 있어요.</p></div>
        <div className={`connection ${demo ? 'demo' : status}`}>● {demo ? '연습 모드' : status === 'online' ? '서버 연결됨' : '연결 확인 중'}</div>
      </section>
      <section className="lobby-mode"><div><small>SELECTED GAME</small><strong>{MODE_INFO[gameMode].label}</strong><span>{state.hostId === playerId || demo ? '방장은 시작 전까지 변경할 수 있어요' : '방장이 선택한 게임으로 진행해요'}</span></div><div className="lobby-mode-buttons">{(['grab', 'shoot', 'zombie', 'balloon', 'racing', 'treasure', 'crown'] as GameMode[]).map(mode => <button key={mode} className={gameMode === mode ? 'selected' : ''} disabled={!demo && state.hostId !== playerId} onClick={() => chooseLobbyMode(mode)}>{MODE_INFO[mode].number} {MODE_INFO[mode].badge}</button>)}</div></section>
      <section className="players"><div className="section-title"><h2>PLAYERS</h2><span>{state.players.length} / 5</span></div>{state.players.map((p, i) => <div className="player-slot" key={p.id}><strong>P{i + 1}</strong><div className={`avatar a${i + 1}`}>{p.nickname.charAt(0)}</div><span>{p.nickname}</span><i>READY</i></div>)}{Array.from({ length: Math.max(0, 5 - state.players.length) }, (_, i) => <div className="player-slot empty" key={i}><strong>?</strong><div className="avatar">+</div><span>친구를 기다리는 중...</span><i>WAIT</i></div>)}</section>
      {state.spectators.length > 0 && <section className="spectator-list"><small>NEXT ROUND</small><b>관전자 {state.spectators.length}명</b><span>{state.spectators.map(spectator => spectator.nickname).join(' · ')}</span></section>}
      <div className="lobby-actions"><button className="ghost" onClick={exitRoom}>← 나가기</button>{demo || state.hostId === playerId ? <button className="primary big" onClick={startGame}>게임 시작 <span>READY?</span></button> : <div className="waiting-host" role="status">방장이 게임을 시작하기를 기다리는 중…</div>}</div>
    </main>}

    {screen === 'game' && <main className={`game mode-${gameMode} feedback-${inputFeedback ?? 'idle'} ${isSpectator ? 'spectating' : ''}`} onClick={() => { if (!isSpectator) inputRef.current?.focus() }}>
      <div className="game-hud"><div><small>{gameMode === 'grab' ? 'ROOM' : 'MODE'}</small><b>{gameMode === 'grab' ? state.roomCode : MODE_INFO[gameMode].title.toUpperCase()}</b></div><div className={`timer ${seconds <= 10 ? 'danger' : ''}`}><small>TIME</small><strong>{String(seconds).padStart(2, '0')}<i>s</i></strong></div><div className="combo"><small>COMBO</small><b>× {me?.combo ?? 0}</b></div></div>
      <div className="scoreboard">{sorted.map((p, i) => <div className={`${p.id === playerId ? 'mine' : ''} ${gameMode === 'crown' && p.id === crownHolderId ? 'has-crown' : ''}`} key={p.id}><span>{i + 1}</span><b>{p.nickname}{gameMode === 'crown' && p.id === crownHolderId ? ' ♛' : ''}</b><em>{p.score.toLocaleString()}</em></div>)}</div>
      <section className={`arena ${gameMode === 'shoot' ? 'shooting-arena' : gameMode === 'zombie' ? 'zombie-arena' : gameMode === 'balloon' ? 'balloon-arena' : gameMode === 'racing' ? 'racing-arena' : gameMode === 'treasure' ? 'treasure-arena' : gameMode === 'crown' ? 'crown-arena' : ''}`}>
        <p className="arena-label">{gameMode === 'shoot' ? 'TRACK · TYPE · SHOOT!' : gameMode === 'zombie' ? 'DEFEND THE LAST KEYBOARD!' : gameMode === 'balloon' ? 'TYPE · POP · CHAIN!' : gameMode === 'racing' ? 'TYPE · BOOST · OVERTAKE!' : gameMode === 'treasure' ? 'CHOOSE · TYPE · DISCOVER!' : gameMode === 'crown' ? 'CAPTURE · DEFEND · RULE!' : 'TYPE ONE & PRESS ENTER'}</p>
        {gameMode === 'grab' && <div className="grab-orders"><b>모두가 지금 같은 단어를 보고 있어요</b><span>먼저 정확히 입력한 1명만 획득</span><span>연속 선점하면 콤보 점수 상승</span></div>}
        {gameMode === 'shoot' && <div className="shooting-orders"><b>접시가 사라지기 전에 조준하세요</b><span>○ 일반 6.2초 · +100</span><span>» 속사 4.6초 · +160</span><span>★ 골드 긴 단어 · +250</span></div>}
        {gameMode === 'zombie' && <><div className="zombie-status"><div><small>BASE CORE</small><strong>{state.modeState?.baseHealth ?? 100}%</strong></div><span className="health-track"><i style={{ width: `${state.modeState?.baseHealth ?? 100}%` }} /></span><div className={nearestZombieSeconds <= 3 ? 'threat-now' : ''}><small>IMPACT</small><strong>{Number.isFinite(nearestZombieSeconds) ? `${nearestZombieSeconds.toFixed(1)}s` : '--'}</strong></div><div><small>WAVE / ZAPS</small><strong>{state.modeState?.wave ?? 1} / {state.modeState?.teamKills ?? 0}</strong></div></div><div className="zombie-orders"><b>먼저 막을 적을 고르세요</b><span className="walker-key">워커 -10</span><span className="armor-key">장갑 -18</span><span className="boomer-key">폭발 -25</span></div></>}
        {gameMode === 'racing' && <><div className={`race-track ${raceLeaderDistance >= 80 ? 'finish-alert' : ''}`}>{state.players.map((player, index) => { const racer = state.modeState?.race?.[player.id] ?? { distance: 0, nitro: 0 }; const position = sorted.findIndex(candidate => candidate.id === player.id) + 1; return <div className={`race-lane ${player.id === playerId ? 'mine' : ''} ${player.id === raceLeaderId ? 'leader' : ''} ${racer.distance >= 80 ? 'near-finish' : ''} ${racer.nitro >= 80 ? 'nitro-hot' : ''}`} key={player.id}><b><i>{position}</i>{player.nickname}</b><span className="road"><i className={`race-car car-${index}`} style={{ '--race-progress': `${racer.distance}%` } as React.CSSProperties}>▰</i><em>FINISH</em></span><small>{Math.round(racer.distance)}m</small><span className="nitro-meter"><i style={{ width: `${racer.nitro}%` }} />NITRO {Math.round(racer.nitro)}%</span></div> })}</div><div className={`race-radio ${myRacePosition === 1 ? 'leading' : ''} ${myRacer.distance >= 80 ? 'final-lap' : ''}`}><b>{myRacePosition === 1 ? '1ST · 선두 유지!' : `${myRacePosition}위 · 선두와 ${Math.round(raceGap)}m`}</b><span>{myRacer.distance >= 80 ? 'FINAL STRETCH' : myRacer.nitro >= 80 ? 'NITRO READY' : `${Math.round(100 - myRacer.distance)}m TO FINISH`}</span></div><div className={`race-choice-guide ${myRacer.nitro >= 80 ? 'near-boost' : ''}`}><b>{myRacer.nitro >= 80 ? '니트로 폭발 직전! 긴 문장에 도전하세요' : '주행 전략을 선택하세요'}</b><span>SPRINT <em>짧고 안전 · +8m</em></span><span>CORNER <em>중간 · +11m</em></span><span>NITRO <em>긴 문장 · +14m</em></span></div></>}
        {gameMode === 'treasure' && <><div className="treasure-inventory"><span>🔑 KEY <b>{myTreasure.keys}</b></span><span>🗺 MAP <b>{myTreasure.maps % 3}/3</b></span><em>{myTreasure.keys > 0 ? '금고를 열 수 있어요!' : '열쇠를 찾아 금고를 해제하세요'}</em></div><div className="treasure-plan"><span className={myTreasure.keys > 0 ? 'ready' : ''}>① 열쇠 획득</span><b>→</b><span className={myTreasure.keys > 0 ? 'ready' : ''}>② 금고 +400</span><i>또는</i><span>지도 3장 +200</span><i>·</i><span>미스터리는 함정 가능</span></div></>}
        {gameMode === 'balloon' && <div className={`balloon-orders ${chainBalloonCount >= 2 ? 'chain-ready' : ''}`}><b>{chainBalloonCount >= 2 ? `연쇄 풍선 ${chainBalloonCount}개 연결됨! 하나를 터뜨리세요` : '일반 풍선을 터뜨리고 폭탄은 피하세요'}</b><span>○ 일반 +100</span><span>◇ 연쇄 +200</span><span>★ 대형 +250</span><span>☠ 폭탄 -100</span></div>}
        {gameMode === 'crown' && <><div key={crownHolderId ?? 'unclaimed'} className={`crown-status crown-arrival ${isCrownHolder ? 'mine' : crownHolderId ? 'rival' : 'unclaimed'}`}><div className="crown-emblem">♛</div><div><small>{isCrownHolder ? 'YOU ARE THE RULER' : crownHolder ? 'STEAL THE CROWN' : 'CROWN UNCLAIMED'}</small><strong>{isCrownHolder ? '왕관을 지키세요!' : crownHolder ? `${crownHolder.nickname}에게서 빼앗으세요!` : '왕관을 먼저 차지하세요!'}</strong><span>{isCrownHolder ? `현재 초당 +${crownRate}점 · 방어할수록 상승` : crownHolder ? '황금 왕관 단어를 먼저 입력하면 즉시 탈취' : '황금 왕관 단어를 가장 먼저 입력하세요'}</span></div><b>×{state.modeState?.crown?.streak ?? 0}<small>POWER</small></b></div><div className="crown-players">{state.players.map(player => <div key={player.id} className={`${player.id === playerId ? 'mine' : ''} ${player.id === crownHolderId ? 'ruler' : ''}`}><i>{player.id === crownHolderId ? '♛' : '·'}</i><span>{player.nickname}</span><small>{((state.modeState?.crown?.heldMs[player.id] ?? 0) / 1000).toFixed(1)}s</small></div>)}</div><div className={`crown-role-banner ${isCrownHolder ? 'defend' : 'steal'}`}><b>{isSpectator ? '전체 상황 관전 중' : isCrownHolder ? '방어 단어를 입력해 POWER를 올리세요' : '황금 단어를 입력해 왕관을 빼앗으세요'}</b><span>{isCrownHolder ? `초당 +${crownRate}점` : '탈취 성공 +150점'}</span></div></>}
        <div className={`targets ${gameMode === 'shoot' ? 'shooting-targets' : gameMode === 'zombie' ? 'zombie-targets' : gameMode === 'balloon' ? 'balloon-targets' : gameMode === 'racing' ? 'racing-targets' : gameMode === 'treasure' ? 'treasure-targets' : gameMode === 'crown' ? `crown-targets ${isCrownHolder ? 'holder-view' : 'challenger-view'}` : ''}`}>{visibleTargetEntries.map(({ target, index: i }) => {
          let zombieStyle: React.CSSProperties | undefined
          let zombieSeconds = Infinity
          if (gameMode === 'shoot' || gameMode === 'zombie' || gameMode === 'balloon') {
            const spawnedAt = target.spawnedAt ?? Date.now()
            if (!zombieDelayRef.current.has(target.id)) zombieDelayRef.current.set(target.id, Math.max(0, Date.now() - spawnedAt))
            const duration = Math.max(1000, (target.expiresAt ?? spawnedAt + 8000) - spawnedAt)
            zombieStyle = gameMode === 'shoot' ? { '--speed': `${duration}ms`, '--delay': `-${zombieDelayRef.current.get(target.id) ?? 0}ms` } as React.CSSProperties : { '--zombie-duration': `${duration}ms`, '--zombie-delay': `-${zombieDelayRef.current.get(target.id) ?? 0}ms` } as React.CSSProperties
            zombieSeconds = Math.max(0, ((target.expiresAt ?? Date.now()) - Date.now()) / 1000)
          }
          const lockedVault = gameMode === 'treasure' && target.kind === 'vault' && myTreasure.keys < 1
          return <article key={target.id} data-target-id={target.id} style={zombieStyle} className={`${prefixMatches(target) ? 'matching' : ''} ${burstIndex === i ? 'bursting' : ''} ${lockedVault ? 'locked' : ''} ${gameMode === 'zombie' && zombieSeconds <= 3 ? 'urgent' : ''} ${target.text.length >= 15 ? 'very-long-target' : target.text.length >= 9 ? 'long-target' : ''} target-${i} ${gameMode === 'shoot' ? `clay plate-${i} plate-${target.kind ?? 'normal'}` : gameMode === 'zombie' ? `zombie zombie-${target.kind ?? 'normal'}` : gameMode === 'balloon' ? `balloon balloon-${target.kind ?? 'balloon'}` : gameMode === 'racing' ? `race-target race-${target.kind ?? 'speed'}` : gameMode === 'treasure' ? `treasure-box treasure-${target.kind ?? 'chest'}` : gameMode === 'crown' ? `crown-target crown-${target.kind ?? 'guard'}` : ''}`}><small>{gameMode === 'shoot' ? target.kind === 'gold' ? '★ GOLD · LONG SHOT · +250' : target.kind === 'fast' ? '» FAST · 4.6s · +160' : '○ CLAY · 6.2s · +100' : target.kind === 'armored' ? '🛡 ARMORED · -18 HP · +180' : target.kind === 'exploder' ? '⚠ BOOMER · -25 HP · +200' : gameMode === 'zombie' ? 'WALKER · -10 HP · +100' : target.kind === 'bomb' ? '☠ BOMB · DO NOT TYPE · -100' : target.kind === 'giant' ? '★ GIANT · LONG · +250' : target.kind === 'chain' ? chainBalloonCount >= 2 ? `◇ CHAIN · POP ×${chainBalloonCount} · +200` : '◇ CHAIN · +150' : gameMode === 'balloon' ? '○ NORMAL · +100' : target.kind === 'nitro' ? '⚡ NITRO · +14m · CHARGE 38%' : target.kind === 'corner' ? '↪ CORNER · +11m · CHARGE 12%' : target.kind === 'speed' ? '» SPRINT · +8m · CHARGE 8%' : target.kind === 'vault' ? lockedVault ? '🔒 VAULT · KEY REQUIRED' : '🔓 VAULT · KEY ×1 · +400' : target.kind === 'key' ? '🔑 KEY · UNLOCK VAULT · +80' : target.kind === 'map' ? '🗺 MAP · COLLECT 3 · +120' : target.kind === 'trap' || target.kind === 'chest' ? '? MYSTERY CHEST' : target.kind === 'crown' ? '♛ TAKE THE CROWN +150' : target.kind === 'guard' ? '◆ DEFEND +80' : `${target.points ?? 100} PTS`}</small><strong>{lockedVault ? '열쇠가 필요합니다' : target.text}</strong><span>{input && prefixMatches(target) && !lockedVault ? `${input.length}/${target.text.length}` : gameMode === 'shoot' ? 'AIM & FIRE' : gameMode === 'zombie' ? 'TYPE TO ZAP' : gameMode === 'balloon' ? target.kind === 'bomb' ? 'AVOID!' : target.kind === 'chain' ? chainBalloonCount >= 2 ? 'CHAIN POP!' : 'WAIT FOR LINK' : 'POP!' : gameMode === 'racing' ? target.kind === 'nitro' ? 'HIGH RISK / HIGH BOOST' : target.kind === 'corner' ? 'BALANCED' : 'SAFE SHIFT' : gameMode === 'treasure' ? lockedVault ? 'LOCKED' : target.kind === 'trap' || target.kind === 'chest' ? 'RISK OPEN' : 'OPEN' : target.kind === 'crown' ? 'CLAIM' : target.kind === 'guard' ? 'GUARD' : 'LOCK ON'}</span>{gameMode === 'zombie' && <em className="zombie-eta">{zombieSeconds <= 3 ? '⚠ ' : ''}{zombieSeconds.toFixed(1)}s</em>}{burstIndex === i && gameMode !== 'shoot' && <div className="pixel-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, pixel) => <i key={pixel} style={{ '--pixel': pixel } as React.CSSProperties} />)}</div>}</article>
        })}{gameMode === 'shoot' && shotEffect && <div className="shot-effect" aria-hidden="true" style={{ '--impact-x': `${shotEffect.x}px`, '--impact-y': `${shotEffect.y}px`, '--shot-length': `${shotEffect.length}px`, '--shot-angle': `${shotEffect.angle}deg` } as React.CSSProperties}><i className="bullet-trail" /><i className="impact-flash" /><b>BANG!</b><span className="clay-shards">{Array.from({ length: 14 }, (_, shard) => <i key={shard} style={{ '--shard': shard, '--fall-x': `${((shard * 37) % 150) - 75}px` } as React.CSSProperties} />)}</span></div>}</div>
        {gameMode === 'zombie' && <div className="last-keyboard" aria-hidden="true"><i /><b>LAST<br />KEYBOARD</b><span>⌨</span></div>}
        {gameMode === 'shoot' && <div className={`range-gun ${shotEffect ? 'firing' : ''}`} aria-hidden="true"><i /><b>TYPE</b></div>}
        {isSpectator ? <div className="spectator-bar"><b>● WATCHING LIVE</b><span>이번 판을 관전 중이에요. 종료 후 자리가 있으면 다음 판에 자동 참가합니다.</span></div> : <form className={`type-form ${inputFeedback ? `is-${inputFeedback}` : ''}`} onSubmit={submit}><div className="prompt">›</div><input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder={gameMode === 'crown' ? isCrownHolder ? '방어 단어를 입력하세요' : '왕관 단어를 입력하세요' : gameMode === 'balloon' ? '풍선 단어 입력 · 폭탄 주의!' : gameMode === 'shoot' ? '날아가는 접시 단어를 입력하세요' : '단어를 입력하세요'} autoComplete="off" autoCapitalize="none" enterKeyHint="send" spellCheck={false} aria-label="단어 입력" /><button>ENTER ↵</button></form>}
        <p className="tip">{isSpectator ? '점수와 타깃이 실시간으로 갱신됩니다.' : gameMode === 'crown' ? isCrownHolder ? '방어 성공 시 POWER가 오르고, 높아진 배수만큼 매초 점수를 얻어요.' : '황금 단어를 먼저 입력하면 현재 보유자에게서 왕관을 즉시 빼앗아요.' : gameMode === 'balloon' ? '연쇄 풍선 하나를 맞히면 연결된 풍선도 함께 터져요. 폭탄 단어는 입력하지 마세요.' : gameMode === 'shoot' ? '빠른 접시는 시간이 짧고, 골드 접시는 긴 단어 대신 큰 점수를 줘요. 놓치면 새 접시가 날아옵니다.' : '화면의 단어를 정확히 입력하고 ENTER! 가장 먼저 보낸 사람이 점수를 얻어요.'}</p>
      </section>
      {effect === 'blur' && <div className="interference blurfx"><b>BLUR ATTACK!</b></div>}
      {effect === 'ink' && <div className="interference inkfx"><i /><i /><i /><b>INK ATTACK!</b></div>}
      {effect === 'shake' && <div className="interference shakefx"><b>SHAKE!</b></div>}
    </main>}

    {screen === 'result' && <main className="result">
      <p className="eyebrow">{isSpectator ? 'WATCH COMPLETE' : gameMode === 'zombie' && state.modeState?.baseHealth === 0 ? 'BASE DESTROYED' : 'GAME CLEAR'}</p><h1>{isSpectator ? 'NEXT ROUND?' : gameMode === 'zombie' ? state.modeState?.baseHealth === 0 ? 'DEFENSE FAILED!' : 'BASE SECURED!' : sorted[0]?.id === playerId ? 'YOU WIN!' : 'NICE TRY!'}</h1>
      <div className="trophy">{gameMode === 'zombie' && state.modeState?.baseHealth === 0 ? '×' : '★'}</div><h2>{gameMode === 'zombie' ? `TEAM ZAPS ${state.modeState?.teamKills ?? 0}` : sorted[0]?.nickname}</h2><p className="final-score">{sorted[0]?.score.toLocaleString()} <small>PTS</small></p>
      <section className="results-table">{sorted.map((p, i) => <div className={p.id === playerId ? 'mine' : ''} key={p.id}><strong>#{i + 1}</strong><span>{p.nickname}</span><b>{p.score.toLocaleString()}</b><em>{gameMode === 'crown' ? `CROWN ${((state.modeState?.crown?.heldMs[p.id] ?? 0) / 1000).toFixed(1)}s` : `MAX ×${p.combo}`}</em></div>)}</section>
      <div className="result-actions">{demo || state.hostId === playerId ? <><button className="primary" onClick={startGame}>한 판 더!</button><button className="ghost" onClick={returnToLobby}>대기실로</button></> : <><div className="waiting-host" role="status">방장의 선택을 기다리는 중…</div><button className="ghost" onClick={exitRoom}>나가기</button></>}</div>
    </main>}
    {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    <footer>© 20XX CATCH TYPING · BEST PLAYED WITH A KEYBOARD</footer>
  </div>
}

export default App
