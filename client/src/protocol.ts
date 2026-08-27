export type Player = { id: string; nickname: string; score: number; combo: number; connected?: boolean }
export type Target = { id: string; text: string; points?: number }
export type MatchState = {
  roomCode: string
  hostId?: string
  phase: 'lobby' | 'playing' | 'finished'
  targets: Target[]
  players: Player[]
  endsAt?: number
  durationMs?: number
}

export type PublicRoom = {
  id: string; hostId: string; status: MatchState['phase']; durationMs: number; endsAt: number | null
  targets: Array<{ id: string; text: string }>
  players: Array<{ id: string; name: string; score: number; combo: number }>
}

export type ClientMessage =
  | { type: 'create_room'; name: string }
  | { type: 'join_room'; name: string; roomId: string }
  | { type: 'leave_room' }
  | { type: 'start_match' }
  | { type: 'return_to_lobby' }
  | { type: 'submit'; targetId: string; text: string }

export type ServerMessage =
  | { type: 'connected'; playerId: string }
  | { type: 'room_left' }
  | { type: 'room_created' | 'room_joined' | 'room_state' | 'match_started' | 'match_ended'; room: PublicRoom }
  | { type: 'submission_result'; playerId: string; targetId: string; outcome: 'success' | 'claimed' | 'miss'; scoreDelta: number; combo: number; replacement?: { id: string; text: string } }
  | { type: 'interference'; fromPlayerId: string; toPlayerId: string; effect: 'blur' | 'ink'; durationMs: number }
  | { type: 'error'; code: string }

export const fromPublicRoom = (room: PublicRoom): MatchState => ({
  roomCode: room.id,
  hostId: room.hostId,
  phase: room.status,
  durationMs: room.durationMs,
  endsAt: room.endsAt ?? undefined,
  targets: room.targets.map(target => ({ ...target, points: 100 })),
  players: room.players.map(player => ({ id: player.id, nickname: player.name, score: player.score, combo: player.combo })),
})

export const configuredWsUrl = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`
