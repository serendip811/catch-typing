export type Player = { id: string; nickname: string; score: number; combo: number; connected?: boolean }
export type Target = { id: string; text: string; points?: number; spawnedAt?: number; expiresAt?: number; kind?: 'normal' | 'armored' | 'exploder' | 'balloon' | 'chain' | 'bomb' | 'giant' | 'speed' | 'nitro' | 'corner' | 'chest' | 'key' | 'trap' | 'vault' | 'map' }
export type GameMode = 'grab' | 'shoot' | 'zombie' | 'balloon' | 'racing' | 'treasure'
export type ModeState = { baseHealth?: number; wave?: number; teamKills?: number; trackLength?: number; race?: Record<string, { distance: number; nitro: number; finishedAt?: number }>; treasure?: Record<string, { keys: number; maps: number }> }
export type MatchState = {
  roomCode: string
  hostId?: string
  mode: GameMode
  phase: 'lobby' | 'playing' | 'finished'
  targets: Target[]
  players: Player[]
  spectators: Array<{ id: string; nickname: string }>
  endsAt?: number
  durationMs?: number
  modeState?: ModeState
}

export type PublicRoom = {
  id: string; hostId: string; mode: GameMode; status: MatchState['phase']; durationMs: number; endsAt: number | null
  modeState?: ModeState
  targets: Array<{ id: string; text: string; spawnedAt?: number; expiresAt?: number; kind?: Target['kind'] }>
  players: Array<{ id: string; name: string; score: number; combo: number }>
  spectators: Array<{ id: string; name: string }>
}

export type RoomSummary = { id: string; mode: GameMode; status: MatchState['phase']; playerCount: number; spectatorCount: number; maxPlayers: number; hostName: string; endsAt: number | null }

export type ClientMessage =
  | { type: 'create_room'; name: string; mode: GameMode }
  | { type: 'join_room'; name: string; roomId: string }
  | { type: 'list_rooms' }
  | { type: 'set_mode'; mode: GameMode }
  | { type: 'leave_room' }
  | { type: 'start_match' }
  | { type: 'return_to_lobby' }
  | { type: 'submit'; targetId: string; text: string }

export type ServerMessage =
  | { type: 'connected'; playerId: string }
  | { type: 'room_list'; rooms: RoomSummary[] }
  | { type: 'room_left' }
  | { type: 'room_created' | 'room_joined' | 'room_state' | 'match_started' | 'match_ended'; room: PublicRoom }
  | { type: 'submission_result'; playerId: string; targetId: string; outcome: 'success' | 'claimed' | 'miss'; scoreDelta: number; combo: number; replacement?: { id: string; text: string } }
  | { type: 'interference'; fromPlayerId: string; toPlayerId: string; effect: 'blur' | 'ink'; durationMs: number }
  | { type: 'error'; code: string }

export const fromPublicRoom = (room: PublicRoom): MatchState => ({
  roomCode: room.id,
  hostId: room.hostId,
  mode: room.mode,
  phase: room.status,
  durationMs: room.durationMs,
  endsAt: room.endsAt ?? undefined,
  modeState: room.modeState,
  targets: room.targets.map(target => ({ ...target, points: 100 })),
  players: room.players.map(player => ({ id: player.id, nickname: player.name, score: player.score, combo: player.combo })),
  spectators: (room.spectators ?? []).map(spectator => ({ id: spectator.id, nickname: spectator.name })),
})

export const configuredWsUrl = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`
