import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { GameEngine } from "./game.js";
import type { GameMode, ServerEvent } from "./types.js";

type ClientMessage =
  | { type: "create_room"; name: string; mode?: GameMode }
  | { type: "join_room"; roomId: string; name: string }
  | { type: "list_rooms" }
  | { type: "set_mode"; mode: GameMode }
  | { type: "leave_room" }
  | { type: "start_match" }
  | { type: "return_to_lobby" }
  | { type: "submit"; targetId: string; text: string };

interface Session { id: string; socket: WebSocket; roomId?: string; isAlive: boolean }

export function createGameServer(port = 8080, engine = new GameEngine()): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const sessions = new Map<WebSocket, Session>();
  const broadcastRoomList = () => {
    const payload = JSON.stringify({ type: "room_list", rooms: engine.listRooms() });
    for (const session of sessions.values()) {
      if (session.socket.readyState === session.socket.OPEN) session.socket.send(payload);
    }
  };

  engine.on("event", (roomId: string, event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const session of sessions.values()) {
      if (session.roomId === roomId && session.socket.readyState === session.socket.OPEN) session.socket.send(payload);
    }
    if (event.type === "room_state" || event.type === "match_started" || event.type === "match_ended") broadcastRoomList();
  });

  wss.on("connection", (socket) => {
    const session: Session = { id: randomUUID(), socket, isAlive: true };
    sessions.set(socket, session);
    send(socket, { type: "connected", playerId: session.id });
    send(socket, { type: "room_list", rooms: engine.listRooms() });

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (!message || typeof message.type !== "string") throw new Error("INVALID_MESSAGE");
        handleMessage(engine, session, message, broadcastRoomList);
      } catch (error) {
        send(socket, { type: "error", code: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
      }
    });
    socket.on("pong", () => { session.isAlive = true; });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      leaveCurrentRoom(engine, session, broadcastRoomList);
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

function handleMessage(engine: GameEngine, session: Session, message: ClientMessage, broadcastRoomList: () => void): void {
  switch (message.type) {
    case "create_room": {
      requireNotInRoom(session);
      const room = engine.createRoom(session.id, requiredString(message.name), gameMode(message.mode));
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
    case "list_rooms":
      send(session.socket, { type: "room_list", rooms: engine.listRooms() });
      break;
    case "set_mode":
      engine.setMode(requireRoom(session), session.id, gameMode(message.mode));
      break;
    case "leave_room":
      leaveCurrentRoom(engine, session, broadcastRoomList);
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

function gameMode(value: unknown): GameMode {
  if (value === undefined) return "grab";
  if (value === "grab" || value === "shoot") return value;
  throw new Error("INVALID_GAME_MODE");
}

function requireRoom(session: Session): string {
  if (!session.roomId) throw new Error("NOT_IN_ROOM");
  return session.roomId;
}

function requireNotInRoom(session: Session): void {
  if (session.roomId) throw new Error("ALREADY_IN_ROOM");
}

function leaveCurrentRoom(engine: GameEngine, session: Session, broadcastRoomList?: () => void): void {
  if (!session.roomId) return;
  const roomId = session.roomId;
  session.roomId = undefined;
  engine.leaveRoom(roomId, session.id);
  broadcastRoomList?.();
}

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}
