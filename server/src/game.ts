import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { KOREAN_TARGETS } from "./words.js";
import type { GameMode, PlayerState, PublicRoom, RoomSummary, ServerEvent, SpectatorState, SubmissionOutcome, Target } from "./types.js";

interface InternalRoom extends PublicRoom {
  claimedTargetIds: Set<string>;
  targetSequence: number;
  wordDeck: string[];
  recentWords: string[];
  timer?: ReturnType<typeof setTimeout>;
  tickTimer?: ReturnType<typeof setInterval>;
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
      targets: [], players: [this.newPlayer(playerId, name)], spectators: [], claimedTargetIds: new Set(), targetSequence: 0, wordDeck: [], recentWords: []
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
    if (room.status === "playing" || room.status === "finished") {
      if (!room.spectators.some((spectator) => spectator.id === playerId)) room.spectators.push(this.newSpectator(playerId, name));
    } else if (!room.players.some((player) => player.id === playerId)) {
      if (room.players.length >= this.maxPlayers) throw new Error("ROOM_FULL");
      room.players.push(this.newPlayer(playerId, name));
    }
    this.broadcast(room, { type: "room_state", room: this.publicRoom(room) });
    return this.publicRoom(room);
  }

  leaveRoom(roomId: string, playerId: string): PublicRoom | undefined {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return undefined;
    const spectatorIndex = room.spectators.findIndex((spectator) => spectator.id === playerId);
    if (spectatorIndex >= 0) {
      room.spectators.splice(spectatorIndex, 1);
      const publicRoom = this.publicRoom(room);
      this.broadcast(room, { type: "room_state", room: publicRoom });
      return publicRoom;
    }
    const index = room.players.findIndex((player) => player.id === playerId);
    if (index < 0) return this.publicRoom(room);

    room.players.splice(index, 1);
    if (room.players.length === 0) {
      if (room.timer) clearTimeout(room.timer);
      if (room.tickTimer) clearInterval(room.tickTimer);
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
    if (room.status === "finished") { this.resetRoom(room); this.promoteSpectators(room); }
    if (room.players.length < this.minPlayers) throw new Error("NOT_ENOUGH_PLAYERS");
    room.status = "playing";
    room.endsAt = this.now() + room.durationMs;
    room.modeState = room.mode === "zombie" ? { baseHealth: 100, wave: 1, teamKills: 0 } : room.mode === "racing" ? { trackLength: 100, race: Object.fromEntries(room.players.map((player) => [player.id, { distance: 0, nitro: 0 }])) } : room.mode === "treasure" ? { treasure: Object.fromEntries(room.players.map((player) => [player.id, { keys: 0, maps: 0 }])) } : undefined;
    room.targets = [];
    for (let index = 0; index < this.targetCount; index += 1) room.targets.push(this.nextTarget(room));
    room.timer = setTimeout(() => this.endMatch(room.id), room.durationMs);
    room.timer.unref?.();
    if (room.mode === "zombie" || room.mode === "balloon") {
      room.tickTimer = setInterval(() => this.advanceMode(room.id), 250);
      room.tickTimer.unref?.();
    }
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "match_started", room: publicRoom });
    return publicRoom;
  }

  returnToLobby(roomId: string, playerId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status === "playing") throw new Error("INVALID_ROOM_STATE");
    this.resetRoom(room);
    this.promoteSpectators(room);
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
    let shouldFinishRace = false;

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
        player.combo = claimed.kind === "bomb" || claimed.kind === "trap" ? 0 : player.combo + 1;
        const treasureBag = room.modeState?.treasure?.[player.id] ?? { keys: 0, maps: 0 };
        scoreDelta = room.mode === "racing" ? claimed.kind === "nitro" ? 180 : claimed.kind === "corner" ? 130 : 100 : room.mode === "treasure" ? claimed.kind === "trap" ? -80 : claimed.kind === "vault" ? treasureBag.keys > 0 ? 400 : 180 : claimed.kind === "map" ? 120 : claimed.kind === "key" ? 80 : 100 : claimed.kind === "bomb" ? -100 : claimed.kind === "giant" ? 250 : claimed.kind === "chain" ? 150 : 100 + Math.min(player.combo - 1, 10) * 10;
        if (claimed.kind === "chain") {
          const chainedIndex = room.targets.findIndex((target, candidateIndex) => candidateIndex !== index && target.kind === "chain");
          if (chainedIndex >= 0) {
            room.claimedTargetIds.add(room.targets[chainedIndex].id);
            room.targets[chainedIndex] = this.nextTarget(room);
            scoreDelta += 50;
          }
        }
        player.score += scoreDelta;
        if (room.mode === "zombie" && room.modeState) {
          room.modeState.teamKills = (room.modeState.teamKills ?? 0) + 1;
          room.modeState.wave = Math.min(9, 1 + Math.floor((room.modeState.teamKills ?? 0) / 8));
          if (player.combo % 3 === 0) room.modeState.baseHealth = Math.min(100, (room.modeState.baseHealth ?? 100) + 5);
        }
        if (room.mode === "racing" && room.modeState?.race) {
          const racer = room.modeState.race[player.id] ?? { distance: 0, nitro: 0 };
          const gainedNitro = claimed.kind === "nitro" ? 38 : claimed.kind === "corner" ? 12 : 8;
          const chargedNitro = Math.min(100, racer.nitro + gainedNitro);
          const boost = chargedNitro >= 100 ? 18 : 0;
          racer.distance = Math.min(room.modeState.trackLength ?? 100, racer.distance + (claimed.kind === "nitro" ? 14 : claimed.kind === "corner" ? 11 : 8) + boost);
          racer.nitro = boost > 0 ? 0 : chargedNitro;
          if (racer.distance >= (room.modeState.trackLength ?? 100)) {
            racer.finishedAt = this.now();
            shouldFinishRace = true;
          }
          room.modeState.race[player.id] = racer;
        }
        if (room.mode === "treasure" && room.modeState?.treasure) {
          const bag = room.modeState.treasure[player.id] ?? { keys: 0, maps: 0 };
          if (claimed.kind === "key") bag.keys += 1;
          if (claimed.kind === "vault" && bag.keys > 0) bag.keys -= 1;
          if (claimed.kind === "map") {
            bag.maps += 1;
            if (bag.maps % 3 === 0) { scoreDelta += 200; player.score += 200; }
          }
          if (claimed.kind === "trap") player.combo = 0;
          room.modeState.treasure[player.id] = bag;
        }
      } else {
        player.combo = 0;
        if (room.mode === "racing" && room.modeState?.race?.[player.id]) {
          const racer = room.modeState.race[player.id];
          racer.distance = Math.max(0, racer.distance - 2);
          racer.nitro = Math.max(0, racer.nitro - 10);
        }
      }
    } else {
      player.combo = 0;
    }

    this.broadcast(room, { type: "submission_result", playerId, targetId, outcome, scoreDelta, combo: player.combo, replacement });
    this.broadcast(room, { type: "room_state", room: this.publicRoom(room) });
    if (room.mode !== "zombie" && room.mode !== "racing" && outcome === "success" && player.combo > 0 && player.combo % 3 === 0) this.emitInterference(room, player);
    if (shouldFinishRace) this.endMatch(room.id);
    return outcome;
  }

  advanceMode(roomId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.status !== "playing") return this.publicRoom(room);
    if (room.mode === "balloon") {
      const expiredIndexes = room.targets.flatMap((target, index) => target.expiresAt !== undefined && target.expiresAt <= this.now() ? [index] : []);
      if (expiredIndexes.length === 0) return this.publicRoom(room);
      for (const index of expiredIndexes) room.targets[index] = this.nextTarget(room);
      const publicRoom = this.publicRoom(room);
      this.broadcast(room, { type: "room_state", room: publicRoom });
      return publicRoom;
    }
    if (room.mode !== "zombie" || !room.modeState) return this.publicRoom(room);
    const expiredIndexes = room.targets.flatMap((target, index) => target.expiresAt !== undefined && target.expiresAt <= this.now() ? [index] : []);
    if (expiredIndexes.length === 0) return this.publicRoom(room);
    const damage = expiredIndexes.reduce((total, index) => total + (room.targets[index].kind === "exploder" ? 20 : room.targets[index].kind === "armored" ? 14 : 10), 0);
    room.modeState.baseHealth = Math.max(0, (room.modeState.baseHealth ?? 100) - damage);
    for (const index of expiredIndexes) room.targets[index] = this.nextTarget(room);
    if (room.modeState.baseHealth === 0) return this.endMatch(room.id);
    const publicRoom = this.publicRoom(room);
    this.broadcast(room, { type: "room_state", room: publicRoom });
    return publicRoom;
  }

  endMatch(roomId: string): PublicRoom {
    const room = this.requireRoom(roomId);
    if (room.status === "finished") return this.publicRoom(room);
    room.status = "finished";
    room.endsAt = null;
    if (room.timer) clearTimeout(room.timer);
    if (room.tickTimer) clearInterval(room.tickTimer);
    room.tickTimer = undefined;
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
      .filter((room) => room.status === "playing" || (room.status === "lobby" && room.players.length < this.maxPlayers))
      .map((room) => ({
        id: room.id,
        mode: room.mode,
        status: room.status,
        playerCount: room.players.length,
        spectatorCount: room.spectators.length,
        maxPlayers: this.maxPlayers,
        hostName: room.players.find((player) => player.id === room.hostId)?.name ?? "Player",
        endsAt: room.endsAt
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
    const text = this.nextWord(room);
    if (room.mode === "balloon") {
      const roll = this.random();
      const kind = roll > .93 ? "bomb" : roll > .82 ? "giant" : roll > .58 ? "chain" : "balloon";
      const lifetime = kind === "giant" ? 11_000 : 7_000 + Math.floor(this.random() * 2_500);
      return { id: `${room.id}-${++room.targetSequence}`, text, spawnedAt: this.now(), expiresAt: this.now() + lifetime, kind };
    }
    if (room.mode === "racing") {
      const roll = this.random();
      const kind = roll > .8 ? "nitro" : roll > .55 ? "corner" : "speed";
      const second = this.nextWord(room);
      return { id: `${room.id}-${++room.targetSequence}`, text: kind === "nitro" ? `${text} ${second}` : text, kind };
    }
    if (room.mode === "treasure") {
      const roll = this.random();
      const kind = roll > .9 ? "vault" : roll > .76 ? "trap" : roll > .58 ? "map" : roll > .4 ? "key" : "chest";
      const second = this.nextWord(room);
      return { id: `${room.id}-${++room.targetSequence}`, text: kind === "vault" ? `${text} ${second}` : text, kind };
    }
    if (room.mode !== "zombie") return { id: `${room.id}-${++room.targetSequence}`, text };
    const wave = room.modeState?.wave ?? 1;
    const lifetime = Math.max(4_800, 10_000 - wave * 550 + Math.floor(this.random() * 2_000));
    const roll = this.random();
    return { id: `${room.id}-${++room.targetSequence}`, text, spawnedAt: this.now(), expiresAt: this.now() + lifetime, kind: roll > .88 ? "exploder" : roll > .7 ? "armored" : "normal" };
  }

  private newPlayer(id: string, name: string): PlayerState {
    return { id, name: name.trim().slice(0, 16) || "Player", score: 0, combo: 0 };
  }

  private newSpectator(id: string, name: string): SpectatorState {
    return { id, name: name.trim().slice(0, 16) || "Viewer" };
  }

  private promoteSpectators(room: InternalRoom): void {
    while (room.players.length < this.maxPlayers && room.spectators.length > 0) {
      const spectator = room.spectators.shift();
      if (spectator) room.players.push(this.newPlayer(spectator.id, spectator.name));
    }
  }

  private nextWord(room: InternalRoom): string {
    const recentLimit = Math.min(15, Math.max(0, this.words.length - this.targetCount));
    const active = new Set(room.targets.map((target) => target.text));
    const recent = new Set(room.recentWords.slice(-recentLimit));
    const take = (avoidRecent: boolean, avoidActive: boolean): string | undefined => {
      if (room.wordDeck.length === 0) room.wordDeck = this.shuffle([...new Set(this.words.map(normalize).filter(Boolean))]);
      const attempts = room.wordDeck.length;
      for (let index = 0; index < attempts; index += 1) {
        const candidate = room.wordDeck.shift();
        if (!candidate) continue;
        if ((avoidRecent && recent.has(candidate)) || (avoidActive && active.has(candidate))) { room.wordDeck.push(candidate); continue; }
        return candidate;
      }
      return undefined;
    };
    const word = take(true, true) ?? take(false, true) ?? take(false, false) ?? this.words[0];
    room.recentWords.push(word);
    if (room.recentWords.length > 30) room.recentWords.shift();
    return word;
  }

  private shuffle(values: string[]): string[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const target = Math.floor(this.random() * (index + 1));
      [values[index], values[target]] = [values[target], values[index]];
    }
    return values;
  }

  private resetRoom(room: InternalRoom): void {
    if (room.timer) clearTimeout(room.timer);
    if (room.tickTimer) clearInterval(room.tickTimer);
    room.timer = undefined;
    room.tickTimer = undefined;
    room.status = "lobby";
    room.endsAt = null;
    room.targets = [];
    room.wordDeck = [];
    room.recentWords = [];
    room.modeState = undefined;
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
      endsAt: room.endsAt, modeState: room.modeState ? { ...room.modeState, ...(room.modeState.race ? { race: Object.fromEntries(Object.entries(room.modeState.race).map(([id, racer]) => [id, { ...racer }])) } : {}), ...(room.modeState.treasure ? { treasure: Object.fromEntries(Object.entries(room.modeState.treasure).map(([id, bag]) => [id, { ...bag }])) } : {}) } : undefined, targets: room.targets.map((target) => ({ ...target })),
      players: room.players.map((player) => ({ ...player })), spectators: room.spectators.map((spectator) => ({ ...spectator }))
    };
  }

  private broadcast(room: InternalRoom, event: ServerEvent): void {
    this.emit("event", room.id, event);
  }
}

function normalize(value: string): string {
  return value.normalize("NFC").trim();
}
