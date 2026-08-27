import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { KOREAN_TARGETS } from "./words.js";
import type { GameMode, PlayerState, PublicRoom, RoomSummary, ServerEvent, SubmissionOutcome, Target } from "./types.js";

interface InternalRoom extends PublicRoom {
  claimedTargetIds: Set<string>;
  targetSequence: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface GameOptions {
  durationMs?: number;
  targetCount?: number;
  maxPlayers?: number;
  minPlayers?: number;
  now?: () => number;
  random?: () => number;
  words?: string[];
  idFactory?: () => string;
}

export class GameEngine extends EventEmitter {
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly durationMs: number;
  private readonly targetCount: number;
  private readonly maxPlayers: number;
  private readonly minPlayers: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly words: string[];
  private readonly idFactory: () => string;

  constructor(options: GameOptions = {}) {
    super();
    this.durationMs = options.durationMs ?? 60_000;
    this.targetCount = Math.max(3, Math.min(5, options.targetCount ?? 4));
    this.maxPlayers = Math.max(2, options.maxPlayers ?? 5);
    this.minPlayers = Math.max(1, Math.min(this.maxPlayers, options.minPlayers ?? 2));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.words = options.words ?? KOREAN_TARGETS;
    this.idFactory = options.idFactory ?? (() => randomBytes(3).toString("hex").toUpperCase());
    if (this.words.length === 0) throw new Error("At least one target word is required");
  }

  createRoom(playerId: string, name: string, mode: GameMode = "grab"): PublicRoom {
    let id = this.idFactory();
    while (this.rooms.has(id)) id = this.idFactory();
    const room: InternalRoom = {
      id, hostId: playerId, mode, status: "lobby", durationMs: this.durationMs, endsAt: null,
      targets: [], players: [this.newPlayer(playerId, name)], claimedTargetIds: new Set(), targetSequence: 0
    };
    this.rooms.set(id, room);
    this.broadcast(room, { type: "room_state", room: this.publicRoom(room) });
    return this.publicRoom(room);
  }

  setMode(roomId: string, playerId: string, mode: GameMode): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status !== "lobby") throw new Error("INVALID_ROOM_STATE");
    room.mode = mode;
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "room_state", room: publicRoom });
    return publicRoom;
  }

  joinRoom(roomId: string, playerId: string, name: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.status !== "lobby") throw new Error("MATCH_ALREADY_STARTED");
    if (!room.players.some((player) => player.id === playerId)) {
      if (room.players.length >= this.maxPlayers) throw new Error("ROOM_FULL");
      room.players.push(this.newPlayer(playerId, name));
    }
    this.broadcast(room, { type: "room_state", room: this.publicRoom(room) });
    return this.publicRoom(room);
  }

  leaveRoom(roomId: string, playerId: string): PublicRoom | undefined {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return undefined;
    const index = room.players.findIndex((player) => player.id === playerId);
    if (index < 0) return this.publicRoom(room);

    room.players.splice(index, 1);
    if (room.players.length === 0) {
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(room.id);
      return undefined;
    }
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "room_state", room: publicRoom });
    return publicRoom;
  }

  startMatch(roomId: string, playerId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status === "playing") throw new Error("INVALID_ROOM_STATE");
    if (room.players.length < this.minPlayers) throw new Error("NOT_ENOUGH_PLAYERS");
    if (room.status === "finished") this.resetRoom(room);
    room.status = "playing";
    room.endsAt = this.now() + room.durationMs;
    room.targets = Array.from({ length: this.targetCount }, () => this.nextTarget(room));
    room.timer = setTimeout(() => this.endMatch(room.id), room.durationMs);
    room.timer.unref?.();
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "match_started", room: publicRoom });
    return publicRoom;
  }

  returnToLobby(roomId: string, playerId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status === "playing") throw new Error("INVALID_ROOM_STATE");
    this.resetRoom(room);
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "room_state", room: publicRoom });
    return publicRoom;
  }

  submit(roomId: string, playerId: string, targetId: string, text: string): SubmissionOutcome {
    const room = this.requireRoom(roomId);
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("PLAYER_NOT_IN_ROOM");
    let outcome: SubmissionOutcome = "miss";
    let scoreDelta = 0;
    let replacement: Target | undefined;

    if (room.status === "playing" && room.endsAt !== null && this.now() < room.endsAt) {
      const index = room.targets.findIndex((target) => target.id === targetId);
      if (index < 0 && room.claimedTargetIds.has(targetId)) {
        outcome = "claimed";
      } else if (index >= 0 && normalize(room.targets[index].text) === normalize(text)) {
        outcome = "success";
        const claimed = room.targets[index];
        room.claimedTargetIds.add(claimed.id);
        replacement = this.nextTarget(room);
        room.targets.splice(index, 1, replacement);
        player.combo += 1;
        scoreDelta = 100 + Math.min(player.combo - 1, 10) * 10;
        player.score += scoreDelta;
      } else {
        player.combo = 0;
      }
    } else {
      player.combo = 0;
    }

    this.broadcast(room, { type: "submission_result", playerId, targetId, outcome, scoreDelta, combo: player.combo, replacement });
    this.broadcast(room, { type: "room_state", room: this.publicRoom(room) });
    if (outcome === "success" && player.combo > 0 && player.combo % 3 === 0) this.emitInterference(room, player);
    return outcome;
  }

  endMatch(roomId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.status === "finished") return this.publicRoom(room);
    room.status = "finished";
    room.endsAt = null;
    if (room.timer) clearTimeout(room.timer);
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "match_ended", room: publicRoom });
    return publicRoom;
  }

  getRoom(roomId: string): PublicRoom | undefined {
    const room = this.rooms.get(roomId);
    return room && this.publicRoom(room);
  }

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.status === "lobby" && room.players.length < this.maxPlayers)
      .map((room) => ({
        id: room.id,
        mode: room.mode,
        status: room.status,
        playerCount: room.players.length,
        maxPlayers: this.maxPlayers,
        hostName: room.players.find((player) => player.id === room.hostId)?.name ?? "Player"
      }));
  }

  private emitInterference(room: InternalRoom, source: PlayerState): void {
    const opponents = room.players.filter((player) => player.id !== source.id);
    if (opponents.length === 0) return;
    const target = opponents.reduce((leader, player) => player.score > leader.score ? player : leader);
    const effect = source.combo % 6 === 0 ? "ink" : "blur";
    this.broadcast(room, { type: "interference", fromPlayerId: source.id, toPlayerId: target.id, effect, durationMs: 1800 });
  }

  private nextTarget(room: InternalRoom): Target {
    const text = this.words[Math.floor(this.random() * this.words.length)] ?? this.words[0];
    return { id: `${room.id}-${++room.targetSequence}`, text };
  }

  private newPlayer(id: string, name: string): PlayerState {
    return { id, name: name.trim().slice(0, 16) || "Player", score: 0, combo: 0 };
  }

  private resetRoom(room: InternalRoom): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
    room.status = "lobby";
    room.endsAt = null;
    room.targets = [];
    room.claimedTargetIds.clear();
    for (const player of room.players) {
      player.score = 0;
      player.combo = 0;
    }
  }

  private requireRoom(roomId: string): InternalRoom {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) throw new Error("ROOM_NOT_FOUND");
    return room;
  }

  private publicRoom(room: InternalRoom): PublicRoom {
    return {
      id: room.id, hostId: room.hostId, mode: room.mode, status: room.status, durationMs: room.durationMs,
      endsAt: room.endsAt, targets: room.targets.map((target) => ({ ...target })),
      players: room.players.map((player) => ({ ...player }))
    };
  }

  private broadcast(room: InternalRoom, event: ServerEvent): void {
    this.emit("event", room.id, event);
  }
}

function normalize(value: string): string {
  return value.normalize("NFC").trim();
}
