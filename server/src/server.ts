import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { GameEngine } from "./game.js";
import type { ServerEvent } from "./types.js";

type ClientMessage =
  | { type: "create_room"; name: string }
  | { type: "join_room"; roomId: string; name: string }
  | { type: "leave_room" }
  | { type: "start_match" }
  | { type: "return_to_lobby" }
  | { type: "submit"; targetId: string; text: string };

interface Session { id: string; socket: WebSocket; roomId?: string; isAlive: boolean }

export function createGameServer(port = 8080, engine = new GameEngine()): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const sessions = new Map<WebSocket, Session>();

  engine.on("event", (roomId: string, event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const session of sessions.values()) {
      if (session.roomId === roomId && session.socket.readyState === session.socket.OPEN) session.socket.send(payload);
    }
  });

  wss.on("connection", (socket) => {
    const session: Session = { id: randomUUID(), socket, isAlive: true };
    sessions.set(socket, session);
    send(socket, { type: "connected", playerId: session.id });

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (!message || typeof message.type !== "string") throw new Error("INVALID_MESSAGE");
        handleMessage(engine, session, message);
      } catch (error) {
        send(socket, { type: "error", code: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
      }
    });
    socket.on("pong", () => { session.isAlive = true; });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      leaveCurrentRoom(engine, session);
      sessions.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.socket.readyState !== session.socket.OPEN) continue;
      if (!session.isAlive) {
        session.socket.terminate();
        continue;
      }
      session.isAlive = false;
      session.socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}

function handleMessage(engine: GameEngine, session: Session, message: ClientMessage): void {
  switch (message.type) {
    case "create_room": {
      requireNotInRoom(session);
      const room = engine.createRoom(session.id, requiredString(message.name));
      session.roomId = room.id;
      send(session.socket, { type: "room_created", room });
      break;
    }
    case "join_room": {
      requireNotInRoom(session);
      const room = engine.joinRoom(requiredString(message.roomId).toUpperCase(), session.id, requiredString(message.name));
      session.roomId = room.id;
      send(session.socket, { type: "room_joined", room });
      break;
    }
    case "leave_room":
      leaveCurrentRoom(engine, session);
      send(session.socket, { type: "room_left" });
      break;
    case "start_match":
      engine.startMatch(requireRoom(session), session.id);
      break;
    case "return_to_lobby":
      engine.returnToLobby(requireRoom(session), session.id);
      break;
    case "submit":
      engine.submit(requireRoom(session), session.id, requiredString(message.targetId), requiredString(message.text));
      break;
    default:
      throw new Error("UNKNOWN_MESSAGE_TYPE");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("INVALID_MESSAGE");
  return value;
}

function requireRoom(session: Session): string {
  if (!session.roomId) throw new Error("NOT_IN_ROOM");
  return session.roomId;
}

function requireNotInRoom(session: Session): void {
  if (session.roomId) throw new Error("ALREADY_IN_ROOM");
}

function leaveCurrentRoom(engine: GameEngine, session: Session): void {
  if (!session.roomId) return;
  const roomId = session.roomId;
  session.roomId = undefined;
  engine.leaveRoom(roomId, session.id);
}

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}
