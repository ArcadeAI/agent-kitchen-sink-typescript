import { Arcade } from "@arcadeai/arcadejs";

// Create a singleton Arcade client instance
// The Arcade constructor looks for process.env.ARCADE_API_KEY by default
const arcadeClient = new Arcade();

export default arcadeClient;

// Export MCP client classes and utilities
// biome-ignore lint/performance/noBarrelFile: This is an intentional index/barrel file for the arcade package
export { createMCPClient, MCPClient } from "./mcp-client.js";
export type {
  MCPClientConfig,
  StdioTransportConfig,
  StreamableHTTPTransportConfig,
  TransportConfig,
} from "./mcp-client-types.js";
export {
  createStdioTransport,
  createStreamableHTTPTransport,
} from "./mcp-client-types.js";
export type { AuthEvent, OpenAIFormattedTool } from "./tools-utils.js";
export {
  AuthorizationPendingError,
  authorizeTools,
  getTools,
  getToolsOpenAI,
  getToolsOpenAIFormatted,
} from "./tools-utils.js";
