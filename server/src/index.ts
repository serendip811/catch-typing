import { createGameServer } from "./server.js";

const parsedPort = Number(process.env.PORT ?? 8080);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
createGameServer(port);
console.log(`Catch Typing server listening on ws://localhost:${port}`);
