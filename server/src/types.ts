export type RoomStatus = "lobby" | "playing" | "finished";
export type GameMode = "grab" | "shoot";

export interface Target {
  id: string;
  text: string;
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
