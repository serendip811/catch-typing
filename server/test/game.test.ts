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
});
