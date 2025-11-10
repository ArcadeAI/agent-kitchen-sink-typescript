import { app } from "./app";
import { SERVER_PORT } from "./constants";

// biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
console.log("=== SERVER STARTING ===");
// biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
console.log("File: apps/server/src/index.ts");
// biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
console.log("Time:", new Date().toISOString());

app.listen(SERVER_PORT, () => {
  // biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
  console.log(`Server is running on port ${SERVER_PORT}`);
  // biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
  console.log("Routes registered:");
  // biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
  console.log("  POST /api/agents/chat");
  // biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
  console.log("  GET /api/arcade/verify");
  // biome-ignore lint/suspicious/noConsole: Server startup logging is intentional
  console.log("  ALL /api/auth/*");
});
