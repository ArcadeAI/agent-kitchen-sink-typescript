import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from the server's .env file
// Resolve path relative to this file's location
// From packages/agents/src/index.ts, we need to go up 3 levels to reach the root
// From packages/agents/dist/src-ChnbC4rN.js, we need to go up 3 levels to reach the root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../../apps/server/.env");

// Load .env file, but don't throw if it doesn't exist (allow override via process.env)
try {
  dotenv.config({
    path: envPath,
  });
} catch (error) {
  // Silently fail if .env file doesn't exist - environment variables might be set elsewhere
  if (error instanceof Error && !error.message.includes("ENOENT")) {
    throw error;
  }
}

export { Agent } from "./openai-agent.js";
export { ReactAgent } from "./openai-react-agent.js";
export type { ReactAgentConfig } from "./openai-react-agent.js";
export type {
  AgentConfig,
  AgentResponse,
  AgentResponseWithState,
  AgentError,
  Message,
  MessageRole,
  SessionState,
  SessionStatus,
  StatePersistenceCallback,
  AgentEvent,
  AgentEventType,
  AgentEventCallback,
} from "./types.js";
