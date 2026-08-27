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

  it("lists only joinable lobby rooms with their mode and player count", () => {
    let sequence = 0;
    const engine = new GameEngine({ idFactory: () => `ROOM0${++sequence}`, maxPlayers: 2, minPlayers: 1 });
    const shoot = engine.createRoom("p1", "슈터", "shoot");
    const playing = engine.createRoom("p2", "캐처", "grab");
    engine.startMatch(playing.id, "p2");
    assert.deepEqual(engine.listRooms(), [{ id: shoot.id, mode: "shoot", status: "lobby", playerCount: 1, maxPlayers: 2, hostName: "슈터" }]);
    engine.joinRoom(shoot.id, "p3", "손님");
    assert.deepEqual(engine.listRooms(), []);
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
