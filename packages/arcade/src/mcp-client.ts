import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPClientConfig } from "./mcp-client-types.js";

/**
 * Modular MCP Client that can be used across the application
 * Supports both server-side (stdio) and client-side (streamable HTTP) transports
 */
export class MCPClient {
	private client: Client | null = null;
	private transport: Transport | null = null;
	private config: MCPClientConfig;
	private isInitialized = false;

	constructor(config: MCPClientConfig) {
		this.config = config;
	}

	/**
	 * Initialize the MCP client with the configured transport
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized && this.client) {
			return;
		}

		try {
			// Determine transport type based on configuration
			const transportConfig = this.config.transport;
			if (transportConfig.type === "stdio") {
				this.transport = new StdioClientTransport({
					command: transportConfig.command,
					args: transportConfig.args || [],
					env: transportConfig.env,
				});
			} else if (transportConfig.type === "streamable-http") {
				if (!transportConfig.url) {
					throw new Error("Streamable HTTP transport requires a URL");
				}
				const options: StreamableHTTPClientTransportOptions = {
					requestInit: transportConfig.requestInit,
					fetch: transportConfig.fetch,
					sessionId: transportConfig.sessionId,
					reconnectionOptions: transportConfig.reconnectionOptions,
					authProvider: transportConfig.authProvider,
				};
				this.transport = new StreamableHTTPClientTransport(
					new URL(transportConfig.url),
					options,
				);
			} else {
				const _exhaustive: never = transportConfig;
				throw new Error(`Unsupported transport type: ${(_exhaustive as { type: string }).type}`);
			}

			this.client = new Client(
				{
					name: this.config.name || "mcp-client",
					version: this.config.version || "1.0.0",
				},
				{
					capabilities: this.config.capabilities || {},
				},
			);

			await this.client.connect(this.transport);
			this.isInitialized = true;
		} catch (error) {
			this.client = null;
			this.transport = null;
			this.isInitialized = false;
			throw error;
		}
	}

	/**
	 * Get the underlying MCP client instance
	 * Throws if not initialized
	 */
	getClient(): Client {
		if (!this.client || !this.isInitialized) {
			throw new Error("MCP client not initialized. Call initialize() first.");
		}
		return this.client;
	}

	/**
	 * Check if the client is initialized
	 */
	isReady(): boolean {
		return this.isInitialized && this.client !== null;
	}

	/**
	 * List available tools from the MCP server
	 */
	async listTools(): Promise<unknown> {
		const client = this.getClient();
		return await client.listTools();
	}

	/**
	 * Call a tool on the MCP server
	 */
	async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
		const client = this.getClient();
		return await client.callTool({ name, arguments: args || {} });
	}

	/**
	 * List available resources from the MCP server
	 */
	async listResources(): Promise<unknown> {
		const client = this.getClient();
		return await client.listResources();
	}

	/**
	 * Read a resource from the MCP server
	 */
	async readResource(uri: string): Promise<unknown> {
		const client = this.getClient();
		return await client.readResource({ uri });
	}

	/**
	 * List available prompts from the MCP server
	 */
	async listPrompts(): Promise<unknown> {
		const client = this.getClient();
		return await client.listPrompts();
	}

	/**
	 * Get a prompt from the MCP server
	 */
	async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
		const client = this.getClient();
		return await client.getPrompt({
			name,
			arguments: (args || {}) as Record<string, string>,
		});
	}

	/**
	 * Close the MCP client connection
	 */
	async close(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
			} catch (error) {
				// Ignore errors during cleanup
				console.error("Error closing MCP client:", error);
			}
		}
		this.client = null;
		this.transport = null;
		this.isInitialized = false;
	}
}

/**
 * Create a new MCP client instance with the given configuration
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
	return new MCPClient(config);
}

