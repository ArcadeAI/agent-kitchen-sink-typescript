import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Configuration for Stdio transport
 */
export type StdioTransportConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/**
 * Configuration for Streamable HTTP transport
 */
export type StreamableHTTPTransportConfig = {
  type: "streamable-http";
  url: string;
  requestInit?: RequestInit;
  fetch?: StreamableHTTPClientTransportOptions["fetch"];
  sessionId?: string;
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
};

/**
 * Union type for all supported transport types
 */
export type TransportConfig =
  | StdioTransportConfig
  | StreamableHTTPTransportConfig;

/**
 * Configuration for the MCP client
 */
export type MCPClientConfig = {
  /**
   * Name of the client
   */
  name?: string;

  /**
   * Version of the client
   */
  version?: string;

  /**
   * Transport configuration (stdio for server, streamable-http for client)
   */
  transport: TransportConfig;

  /**
   * Client capabilities
   */
  capabilities?: ClientCapabilities;
};

/**
 * Helper function to create a stdio transport config
 */
export function createStdioTransport(
  command: string,
  args?: string[],
  env?: Record<string, string>
): StdioTransportConfig {
  return {
    type: "stdio",
    command,
    args,
    env,
  };
}

/**
 * Helper function to create a Streamable HTTP transport config
 */
export function createStreamableHTTPTransport(
  url: string,
  options?: Omit<StreamableHTTPTransportConfig, "type" | "url">
): StreamableHTTPTransportConfig {
  return {
    type: "streamable-http",
    url,
    ...options,
  };
}
