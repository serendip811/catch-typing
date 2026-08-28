export type RoomStatus = "lobby" | "playing" | "finished";
export type GameMode = "grab" | "shoot" | "zombie" | "balloon" | "racing" | "treasure";

export interface Target {
  id: string;
  text: string;
  spawnedAt?: number;
  expiresAt?: number;
  kind?: "normal" | "armored" | "exploder" | "balloon" | "chain" | "bomb" | "giant" | "speed" | "nitro" | "corner" | "chest" | "key" | "trap" | "vault" | "map";
}

export interface ModeState {
  baseHealth?: number;
  wave?: number;
  teamKills?: number;
  trackLength?: number;
  race?: Record<string, { distance: number; nitro: number; finishedAt?: number }>;
  treasure?: Record<string, { keys: number; maps: number }>;
}

export interface PlayerState {
  id: string;
  name: string;
  score: number;
  combo: number;
}

export type SubmissionOutcome = "success" | "claimed" | "miss";

export type ServerEvent =
  | { type: "room_state"; room: PublicRoom }
  | { type: "match_started"; room: PublicRoom }
  | { type: "submission_result"; playerId: string; targetId: string; outcome: SubmissionOutcome; scoreDelta: number; combo: number; replacement?: Target }
  | { type: "interference"; fromPlayerId: string; toPlayerId: string; effect: "blur" | "ink"; durationMs: number }
  | { type: "match_ended"; room: PublicRoom };

export interface PublicRoom {
  id: string;
  hostId: string;
  mode: GameMode;
  status: RoomStatus;
  durationMs: number;
  endsAt: number | null;
  modeState?: ModeState;
  targets: Target[];
  players: PlayerState[];
}

export interface RoomSummary {
  id: string;
  mode: GameMode;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  hostName: string;
}
