import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GameEngine } from "../src/game.js";
import type { ServerEvent } from "../src/types.js";

function fixture(durationMs = 60_000) {
  let now = 1_000;
  const engine = new GameEngine({
    durationMs, targetCount: 3, now: () => now, random: () => 0,
    words: ["번개", "집중"], idFactory: () => "ABC123"
  });
  const room = engine.createRoom("p1", "하나");
  engine.joinRoom(room.id, "p2", "둘");
  const started = engine.startMatch(room.id, "p1");
  return { engine, started, setNow: (value: number) => { now = value; } };
}

describe("GameEngine", () => {
  it("stores the selected game mode and lets only the host change it in the lobby", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const room = engine.createRoom("host", "방장", "shoot");
    engine.joinRoom(room.id, "guest", "손님");
    assert.equal(room.mode, "shoot");
    assert.throws(() => engine.setMode(room.id, "guest", "grab"), /HOST_ONLY/);
    assert.equal(engine.setMode(room.id, "host", "grab").mode, "grab");
    engine.startMatch(room.id, "host");
    assert.throws(() => engine.setMode(room.id, "host", "shoot"), /INVALID_ROOM_STATE/);
  });

  it("starts zombie defense with shared base, wave, and timed enemies", () => {
    let now = 1_000;
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, now: () => now, random: () => 0, words: ["번개"], idFactory: () => "BASE01" });
    const room = engine.createRoom("host", "방장", "zombie");
    const started = engine.startMatch(room.id, "host");
    assert.deepEqual(started.modeState, { baseHealth: 100, wave: 1, teamKills: 0 });
    assert.equal(started.targets.length, 3);
    assert.ok(started.targets.every((target) => target.kind === "normal" && target.spawnedAt === 1_000 && target.expiresAt === 10_450));

    now = 10_450;
    const advanced = engine.advanceMode(room.id);
    assert.equal(advanced.modeState?.baseHealth, 70);
    assert.ok(advanced.targets.every((target) => target.spawnedAt === 10_450));
    engine.endMatch(room.id);
  });

  it("heals the zombie base on a three-combo and never attacks teammates", () => {
    let now = 1_000;
    const events: ServerEvent[] = [];
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, now: () => now, random: () => 0, words: ["번개"], idFactory: () => "BASE01" });
    const room = engine.createRoom("host", "방장", "zombie");
    engine.startMatch(room.id, "host");
    engine.on("event", (_roomId, event) => events.push(event));
    now = 10_450;
    engine.advanceMode(room.id);
    for (let index = 0; index < 3; index += 1) {
      const target = engine.getRoom(room.id)!.targets[0];
      assert.equal(engine.submit(room.id, "host", target.id, target.text), "success");
    }
    assert.equal(engine.getRoom(room.id)?.modeState?.teamKills, 3);
    assert.equal(engine.getRoom(room.id)?.modeState?.baseHealth, 75);
    assert.equal(events.some((event) => event.type === "interference"), false);
    engine.endMatch(room.id);
  });

  it("replaces balloon targets that float off screen", () => {
    let now = 1_000;
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, now: () => now, random: () => 0, words: ["풍선"], idFactory: () => "POP001" });
    const room = engine.createRoom("host", "방장", "balloon");
    const started = engine.startMatch(room.id, "host");
    assert.ok(started.targets.every((target) => target.kind === "balloon" && target.expiresAt === 8_000));
    const firstIds = started.targets.map((target) => target.id);
    now = 8_000;
    const advanced = engine.advanceMode(room.id);
    assert.ok(advanced.targets.every((target, index) => target.id !== firstIds[index] && target.spawnedAt === 8_000));
    engine.endMatch(room.id);
  });

  it("awards chain pops and penalizes bomb balloons", () => {
    const chainEngine = new GameEngine({ minPlayers: 1, targetCount: 3, random: () => .7, words: ["연쇄"], idFactory: () => "CHAIN1" });
    const chainRoom = chainEngine.createRoom("host", "방장", "balloon");
    chainEngine.startMatch(chainRoom.id, "host");
    const chainTarget = chainEngine.getRoom(chainRoom.id)!.targets[0];
    assert.equal(chainTarget.kind, "chain");
    assert.equal(chainEngine.submit(chainRoom.id, "host", chainTarget.id, chainTarget.text), "success");
    assert.equal(chainEngine.getRoom(chainRoom.id)?.players[0].score, 200);
    chainEngine.endMatch(chainRoom.id);

    const bombEngine = new GameEngine({ minPlayers: 1, targetCount: 3, random: () => .95, words: ["폭탄"], idFactory: () => "BOMB01" });
    const bombRoom = bombEngine.createRoom("host", "방장", "balloon");
    bombEngine.startMatch(bombRoom.id, "host");
    const bombTarget = bombEngine.getRoom(bombRoom.id)!.targets[0];
    assert.equal(bombTarget.kind, "bomb");
    assert.equal(bombEngine.submit(bombRoom.id, "host", bombTarget.id, bombTarget.text), "success");
    assert.equal(bombEngine.getRoom(bombRoom.id)?.players[0].score, -100);
    assert.equal(bombEngine.getRoom(bombRoom.id)?.players[0].combo, 0);
    bombEngine.endMatch(bombRoom.id);
  });

  it("tracks racing distance, nitro, mistakes, and the finish line", () => {
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, random: () => 0, words: ["출발"], idFactory: () => "RACE01" });
    const room = engine.createRoom("host", "레이서", "racing");
    const started = engine.startMatch(room.id, "host");
    assert.deepEqual(started.modeState, { trackLength: 100, race: { host: { distance: 0, nitro: 0 } } });
    assert.ok(started.targets.every((target) => target.kind === "speed"));
    let target = engine.getRoom(room.id)!.targets[0];
    engine.submit(room.id, "host", target.id, target.text);
    assert.equal(engine.getRoom(room.id)?.modeState?.race?.host.distance, 8);
    engine.submit(room.id, "host", "missing", "오타");
    assert.equal(engine.getRoom(room.id)?.modeState?.race?.host.distance, 6);
    for (let index = 0; index < 12; index += 1) {
      target = engine.getRoom(room.id)!.targets[0];
      engine.submit(room.id, "host", target.id, target.text);
    }
    assert.equal(engine.getRoom(room.id)?.status, "finished");
    assert.equal(engine.getRoom(room.id)?.modeState?.race?.host.distance, 100);
  });

  it("charges and automatically spends racing nitro", () => {
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, random: () => .9, words: ["네온"], idFactory: () => "NITRO1" });
    const room = engine.createRoom("host", "레이서", "racing");
    engine.startMatch(room.id, "host");
    for (let index = 0; index < 3; index += 1) {
      const target = engine.getRoom(room.id)!.targets[0];
      assert.equal(target.kind, "nitro");
      assert.equal(engine.submit(room.id, "host", target.id, target.text), "success");
    }
    assert.deepEqual(engine.getRoom(room.id)?.modeState?.race?.host, { distance: 60, nitro: 0 });
    engine.endMatch(room.id);
  });

  it("collects treasure keys and spends one to open a high-value vault", () => {
    let roll = .5;
    const engine = new GameEngine({ minPlayers: 1, targetCount: 1, random: () => roll, words: ["보석", "금화"], idFactory: () => "LOOT01" });
    const room = engine.createRoom("host", "탐험가", "treasure");
    const started = engine.startMatch(room.id, "host");
    assert.deepEqual(started.modeState, { treasure: { host: { keys: 0, maps: 0 } } });
    let target = engine.getRoom(room.id)!.targets[0];
    assert.equal(target.kind, "key");
    roll = .95;
    engine.submit(room.id, "host", target.id, target.text);
    assert.deepEqual(engine.getRoom(room.id)?.modeState?.treasure?.host, { keys: 1, maps: 0 });
    target = engine.getRoom(room.id)!.targets[0];
    assert.equal(target.kind, "vault");
    engine.submit(room.id, "host", target.id, target.text);
    assert.equal(engine.getRoom(room.id)?.players[0].score, 480);
    assert.deepEqual(engine.getRoom(room.id)?.modeState?.treasure?.host, { keys: 0, maps: 0 });
    engine.endMatch(room.id);
  });

  it("awards map set bonuses and resets combo on treasure traps", () => {
    let roll = .7;
    const engine = new GameEngine({ minPlayers: 1, targetCount: 1, random: () => roll, words: ["유물"], idFactory: () => "MAP001" });
    const room = engine.createRoom("host", "탐험가", "treasure");
    engine.startMatch(room.id, "host");
    for (let index = 0; index < 3; index += 1) {
      const target = engine.getRoom(room.id)!.targets[0];
      assert.equal(target.kind, "map");
      if (index === 2) roll = .8;
      engine.submit(room.id, "host", target.id, target.text);
    }
    assert.equal(engine.getRoom(room.id)?.players[0].score, 560);
    assert.deepEqual(engine.getRoom(room.id)?.modeState?.treasure?.host, { keys: 0, maps: 3 });
    const target = engine.getRoom(room.id)!.targets[0];
    assert.equal(target.kind, "trap");
    engine.submit(room.id, "host", target.id, target.text);
    assert.equal(engine.getRoom(room.id)?.players[0].score, 480);
    assert.equal(engine.getRoom(room.id)?.players[0].combo, 0);
    engine.endMatch(room.id);
  });

  it("starts Crown Keeper with one shared crown and guard targets", () => {
    const engine = new GameEngine({ minPlayers: 1, targetCount: 5, random: () => 0, words: ["왕관", "수비", "성벽", "기사", "황금"], idFactory: () => "CROWN1" });
    const room = engine.createRoom("host", "왕", "crown");
    const started = engine.startMatch(room.id, "host");
    assert.deepEqual(started.modeState?.crown, { streak: 0, heldMs: { host: 0 } });
    assert.equal(started.targets.filter((target) => target.kind === "crown").length, 1);
    assert.equal(started.targets.filter((target) => target.kind === "guard").length, 4);
    engine.endMatch(room.id);
  });

  it("transfers the crown and awards authoritative hold points", () => {
    let now = 1_000;
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, now: () => now, random: () => 0, words: ["왕관", "수비", "성벽", "기사"], idFactory: () => "CROWN1" });
    const room = engine.createRoom("host", "왕", "crown");
    engine.joinRoom(room.id, "rival", "도전자");
    engine.startMatch(room.id, "host");
    let crownTarget = engine.getRoom(room.id)!.targets.find((target) => target.kind === "crown")!;
    engine.submit(room.id, "host", crownTarget.id, crownTarget.text);
    assert.deepEqual(engine.getRoom(room.id)?.modeState?.crown, { holderId: "host", streak: 1, heldMs: { host: 0, rival: 0 } });
    now = 2_000;
    engine.advanceMode(room.id);
    assert.equal(engine.getRoom(room.id)?.players.find((player) => player.id === "host")?.score, 160);
    assert.equal(engine.getRoom(room.id)?.modeState?.crown?.heldMs.host, 1_000);

    crownTarget = engine.getRoom(room.id)!.targets.find((target) => target.kind === "crown")!;
    engine.submit(room.id, "rival", crownTarget.id, crownTarget.text);
    assert.equal(engine.getRoom(room.id)?.modeState?.crown?.holderId, "rival");
    now = 4_000;
    engine.advanceMode(room.id);
    assert.equal(engine.getRoom(room.id)?.players.find((player) => player.id === "rival")?.score, 170);
    assert.equal(engine.getRoom(room.id)?.modeState?.crown?.heldMs.rival, 2_000);
    engine.endMatch(room.id);
  });

  it("builds Crown Keeper defense power without attacking opponents", () => {
    let now = 1_000;
    const events: ServerEvent[] = [];
    const engine = new GameEngine({ minPlayers: 1, targetCount: 3, now: () => now, random: () => 0, words: ["왕관", "방패", "성문", "기사"], idFactory: () => "CROWN1" });
    const room = engine.createRoom("host", "왕", "crown");
    engine.startMatch(room.id, "host");
    engine.on("event", (_roomId, event) => events.push(event));
    let target = engine.getRoom(room.id)!.targets.find((candidate) => candidate.kind === "crown")!;
    engine.submit(room.id, "host", target.id, target.text);
    for (let index = 0; index < 2; index += 1) {
      target = engine.getRoom(room.id)!.targets.find((candidate) => candidate.kind === "guard")!;
      engine.submit(room.id, "host", target.id, target.text);
    }
    assert.equal(engine.getRoom(room.id)?.modeState?.crown?.streak, 3);
    assert.equal(engine.getRoom(room.id)?.players[0].score, 410);
    now = 2_000;
    engine.advanceMode(room.id);
    assert.equal(engine.getRoom(room.id)?.players[0].score, 440);
    assert.equal(events.some((event) => event.type === "interference"), false);
    engine.endMatch(room.id);
  });

  it("lists joinable lobby rooms and playing rooms available to watch", () => {
    let sequence = 0;
    const engine = new GameEngine({ idFactory: () => `ROOM0${++sequence}`, maxPlayers: 2, minPlayers: 1 });
    const shoot = engine.createRoom("p1", "슈터", "shoot");
    const playing = engine.createRoom("p2", "캐처", "grab");
    engine.startMatch(playing.id, "p2");
    assert.deepEqual(engine.listRooms().map(({ id, status }) => ({ id, status })), [{ id: shoot.id, status: "lobby" }, { id: playing.id, status: "playing" }]);
    engine.joinRoom(shoot.id, "p3", "손님");
    assert.deepEqual(engine.listRooms().map(({ id, status }) => ({ id, status })), [{ id: playing.id, status: "playing" }]);
  });

  it("shows playing rooms and joins late arrivals as spectators for the next round", () => {
    const engine = new GameEngine({ minPlayers: 1, idFactory: () => "LIVE01", words: ["하나", "둘", "셋", "넷"] });
    const room = engine.createRoom("host", "방장", "grab");
    engine.startMatch(room.id, "host");
    const watched = engine.joinRoom(room.id, "viewer", "관전자");
    assert.deepEqual(watched.players.map((player) => player.name), ["방장"]);
    assert.deepEqual(watched.spectators.map((spectator) => spectator.name), ["관전자"]);
    assert.equal(engine.listRooms()[0]?.status, "playing");
    assert.equal(engine.listRooms()[0]?.spectatorCount, 1);
    assert.throws(() => engine.submit(room.id, "viewer", watched.targets[0].id, watched.targets[0].text), /PLAYER_NOT_IN_ROOM/);
    engine.endMatch(room.id);
    const lobby = engine.returnToLobby(room.id, "host");
    assert.deepEqual(lobby.players.map((player) => player.name), ["방장", "관전자"]);
    assert.deepEqual(lobby.spectators, []);
  });

  it("uses a room shuffle deck without active or recently shown duplicates", () => {
    const words = Array.from({ length: 30 }, (_, index) => `단어${index}`);
    const engine = new GameEngine({ minPlayers: 1, targetCount: 5, random: () => .37, words, idFactory: () => "DECK01" });
    const room = engine.createRoom("host", "방장", "grab");
    const started = engine.startMatch(room.id, "host");
    assert.equal(new Set(started.targets.map((target) => target.text)).size, 5);
    const seen = started.targets.map((target) => target.text);
    for (let index = 0; index < 10; index += 1) {
      const target = engine.getRoom(room.id)!.targets[0];
      engine.submit(room.id, "host", target.id, target.text);
      const replacement = engine.getRoom(room.id)!.targets[0].text;
      assert.equal(seen.slice(-15).includes(replacement), false);
      seen.push(replacement);
    }
    engine.endMatch(room.id);
  });

  it("creates three to five shared targets and a 60 second match", () => {
    const { started } = fixture();
    assert.equal(started.targets.length, 3);
    assert.equal(started.endsAt, 61_000);
    assert.equal(started.players.length, 2);
  });

  it("atomically awards a target to only the first valid submission", () => {
    const { engine, started } = fixture();
    const target = started.targets[0];
    assert.equal(engine.submit(started.id, "p1", target.id, target.text), "success");
    assert.equal(engine.submit(started.id, "p2", target.id, target.text), "claimed");
    const players = engine.getRoom(started.id)!.players;
    assert.deepEqual(players.find((player) => player.id === "p1"), { id: "p1", name: "하나", score: 100, combo: 1 });
    assert.deepEqual(players.find((player) => player.id === "p2"), { id: "p2", name: "둘", score: 0, combo: 0 });
  });

  it("returns miss and resets combo for incorrect text", () => {
    const { engine, started } = fixture();
    const first = started.targets[0];
    engine.submit(started.id, "p1", first.id, first.text);
    const next = engine.getRoom(started.id)!.targets[0];
    assert.equal(engine.submit(started.id, "p1", next.id, "오타"), "miss");
    assert.equal(engine.getRoom(started.id)?.players[0].combo, 0);
  });

  it("broadcasts the authoritative room state after every submission", () => {
    const { engine, started } = fixture();
    const events: ServerEvent[] = [];
    engine.on("event", (_roomId, event) => events.push(event));
    const target = started.targets[0];
    engine.submit(started.id, "p1", target.id, target.text);
    const roomState = events.find((event) => event.type === "room_state");
    assert.ok(roomState && roomState.type === "room_state");
    assert.equal(roomState.room.players[0].score, 100);
    assert.notEqual(roomState.room.targets[0].id, target.id);
  });

  it("emits alternating automatic interference on combo milestones", () => {
    const { engine, started } = fixture();
    const events: ServerEvent[] = [];
    engine.on("event", (_roomId, event) => events.push(event));
    for (let index = 0; index < 6; index += 1) {
      const target = engine.getRoom(started.id)!.targets[0];
      engine.submit(started.id, "p1", target.id, target.text);
    }
    const interference = events.filter((event) => event.type === "interference");
    assert.equal(interference.length, 2);
    assert.equal(interference[0].effect, "blur");
    assert.equal(interference[0].toPlayerId, "p2");
    assert.equal(interference[1].effect, "ink");
    assert.equal(interference[1].toPlayerId, "p2");
  });

  it("rejects scoring after the authoritative deadline", () => {
    const { engine, started, setNow } = fixture();
    setNow(started.endsAt!);
    assert.equal(engine.submit(started.id, "p1", started.targets[0].id, started.targets[0].text), "miss");
    assert.equal(engine.getRoom(started.id)?.players[0].score, 0);
  });

  it("restricts match start to the host", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const room = engine.createRoom("host", "방장");
    engine.joinRoom(room.id, "guest", "손님");
    assert.throws(() => engine.startMatch(room.id, "guest"), /HOST_ONLY/);
  });

  it("transfers host ownership when the host leaves", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const room = engine.createRoom("host", "방장");
    engine.joinRoom(room.id, "guest", "손님");
    const remaining = engine.leaveRoom(room.id, "host");
    assert.equal(remaining?.hostId, "guest");
    assert.deepEqual(remaining?.players.map((player) => player.id), ["guest"]);
  });

  it("deletes an empty room and clears its match timer", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01", minPlayers: 1 });
    const room = engine.createRoom("host", "방장");
    engine.startMatch(room.id, "host");
    assert.equal(engine.leaveRoom(room.id, "host"), undefined);
    assert.equal(engine.getRoom(room.id), undefined);
  });

  it("enforces room capacity", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01", maxPlayers: 2 });
    const room = engine.createRoom("p1", "하나");
    engine.joinRoom(room.id, "p2", "둘");
    assert.throws(() => engine.joinRoom(room.id, "p3", "셋"), /ROOM_FULL/);
  });

  it("requires at least two players for a multiplayer match", () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const room = engine.createRoom("host", "방장");
    assert.throws(() => engine.startMatch(room.id, "host"), /NOT_ENOUGH_PLAYERS/);
  });

  it("resets scores and starts a rematch from a finished room", () => {
    const { engine, started } = fixture();
    const target = started.targets[0];
    engine.submit(started.id, "p1", target.id, target.text);
    engine.endMatch(started.id);
    const restarted = engine.startMatch(started.id, "p1");
    assert.equal(restarted.status, "playing");
    assert.deepEqual(restarted.players.map((player) => player.score), [0, 0]);
    assert.equal(restarted.targets.length, 3);
  });

  it("returns a finished room to a clean lobby", () => {
    const { engine, started } = fixture();
    engine.endMatch(started.id);
    const lobby = engine.returnToLobby(started.id, "p1");
    assert.equal(lobby.status, "lobby");
    assert.equal(lobby.endsAt, null);
    assert.deepEqual(lobby.targets, []);
  });
});
