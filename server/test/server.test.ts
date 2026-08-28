import assert from "node:assert/strict";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { GameEngine } from "../src/game.js";
import { createGameServer } from "../src/server.js";

type Message = { type: string; [key: string]: unknown };

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket, predicate: (message: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Message;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("WebSocket room lifecycle", () => {
  it("publishes selectable game modes in the public room list", async () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const server = createGameServer(0, engine);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}`;
    const observer = await connect(url);
    const host = await connect(url);
    const listed = waitForMessage(observer, (message) => message.type === "room_list" && (message.rooms as unknown[]).length === 1);
    const created = waitForMessage(host, (message) => message.type === "room_created");
    host.send(JSON.stringify({ type: "create_room", name: "슈터", mode: "shoot" }));
    const [listMessage, createdMessage] = await Promise.all([listed, created]);
    assert.equal((createdMessage.room as { mode: string }).mode, "shoot");
    assert.deepEqual((listMessage.rooms as Array<{ id: string; mode: string; playerCount: number }>).map(({ id, mode, playerCount }) => ({ id, mode, playerCount })), [{ id: "ROOM01", mode: "shoot", playerCount: 1 }]);

    await close(host);
    await close(observer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns ROOM_NOT_FOUND when an invitation points to a deleted room", async () => {
    const server = createGameServer(0, new GameEngine());
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const socket = await connect(`ws://127.0.0.1:${address.port}`);
    const errorMessage = waitForMessage(socket, (message) => message.type === "error");
    socket.send(JSON.stringify({ type: "join_room", roomId: "GONE01", name: "손님" }));
    const message = await errorMessage;
    assert.equal(message.code, "ROOM_NOT_FOUND");

    await close(socket);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lets a late arrival watch a running match without becoming a player", async () => {
    const engine = new GameEngine({ minPlayers: 1, idFactory: () => "LIVE01", words: ["하나", "둘", "셋"] });
    const server = createGameServer(0, engine);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}`;
    const host = await connect(url);
    const created = waitForMessage(host, (message) => message.type === "room_created");
    host.send(JSON.stringify({ type: "create_room", name: "방장" }));
    await created;
    const started = waitForMessage(host, (message) => message.type === "match_started");
    host.send(JSON.stringify({ type: "start_match" }));
    await started;

    const viewer = await connect(url);
    const joined = waitForMessage(viewer, (message) => message.type === "room_joined");
    viewer.send(JSON.stringify({ type: "join_room", roomId: "LIVE01", name: "관전자" }));
    const message = await joined;
    const joinedRoom = message.room as { players: unknown[]; spectators: Array<{ name: string }> };
    assert.equal(joinedRoom.players.length, 1);
    assert.deepEqual(joinedRoom.spectators.map((spectator) => spectator.name), ["관전자"]);

    await close(viewer);
    await close(host);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("handles an explicit leave message and broadcasts the updated room", async () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const server = createGameServer(0, engine);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}`;

    const host = await connect(url);
    const createdMessage = waitForMessage(host, (message) => message.type === "room_created");
    host.send(JSON.stringify({ type: "create_room", name: "방장" }));
    await createdMessage;

    const guest = await connect(url);
    const joinedMessage = waitForMessage(guest, (message) => message.type === "room_joined");
    guest.send(JSON.stringify({ type: "join_room", roomId: "ROOM01", name: "손님" }));
    await joinedMessage;

    const roomUpdated = waitForMessage(host, (message) => {
      if (message.type !== "room_state") return false;
      return (message.room as { players: unknown[] }).players.length === 1;
    });
    const roomLeft = waitForMessage(guest, (message) => message.type === "room_left");
    guest.send(JSON.stringify({ type: "leave_room" }));
    await Promise.all([roomUpdated, roomLeft]);
    assert.deepEqual(engine.getRoom("ROOM01")?.players.map((player) => player.name), ["방장"]);

    await close(guest);
    await close(host);
    assert.equal(engine.getRoom("ROOM01"), undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("removes disconnected players, transfers host, and deletes the empty room", async () => {
    const engine = new GameEngine({ idFactory: () => "ROOM01" });
    const server = createGameServer(0, engine);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}`;

    const host = await connect(url);
    const createdMessage = waitForMessage(host, (message) => message.type === "room_created");
    host.send(JSON.stringify({ type: "create_room", name: "방장" }));
    await createdMessage;

    const guest = await connect(url);
    const joinedMessage = waitForMessage(guest, (message) => message.type === "room_joined");
    guest.send(JSON.stringify({ type: "join_room", roomId: "ROOM01", name: "손님" }));
    await joinedMessage;
    assert.equal(engine.getRoom("ROOM01")?.players.length, 2);

    const hostTransferred = waitForMessage(guest, (message) => {
      if (message.type !== "room_state") return false;
      const room = message.room as { hostId: string; players: unknown[] };
      return room.hostId !== undefined && room.players.length === 1;
    });
    await close(host);
    const state = await hostTransferred;
    assert.equal((state.room as { hostId: string }).hostId, engine.getRoom("ROOM01")?.players[0].id);

    await close(guest);
    assert.equal(engine.getRoom("ROOM01"), undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
