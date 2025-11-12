import { getToolsOpenAI } from "@gmail-agents/arcade";
import { Agent } from "./openai-agent.js";
import type {
  AgentConfig,
  AgentEventCallback,
  AgentResponseWithState,
  Message,
  SessionState,
} from "./types.js";

const DEFAULT_TOOL_LIMIT = 30;

/**
 * Configuration for ReactAgent
 */
export interface ReactAgentConfig extends AgentConfig {
  /** Toolkits to load from Arcade */
  toolkits?: string[];
  /** Individual tools to load from Arcade */
  tools?: string[];
  /** Maximum number of tools to load */
  toolLimit?: number;
  /** User ID for context and tool authorization */
  userId?: string;
}

/**
 * React agent that extends the base Agent with tool-calling capabilities
 * Uses Arcade tools via the getToolsOpenAI function
 */
export class ReactAgent extends Agent {
  private readonly toolkits: string[];
  private readonly tools: string[];
  private readonly toolLimit: number;
  private readonly userId?: string;

  constructor(config: ReactAgentConfig = {}) {
    super(config);
    if (!config.userId) {
      throw new Error("userId is required");
    }
    this.toolkits = config.toolkits ?? [];
    this.tools = config.tools ?? [];
    this.toolLimit = config.toolLimit ?? DEFAULT_TOOL_LIMIT;
    this.userId = config.userId;
  }

  /**
   * Static factory method to create a ReactAgent with tools initialized
   */
  static async create(config: ReactAgentConfig = {}): Promise<ReactAgent> {
    const agent = new ReactAgent(config);
    const tools = await getToolsOpenAI({
      toolkits: agent.toolkits,
      tools: agent.tools,
      limit: agent.toolLimit,
      userId: agent.userId,
    });
    agent.addTools(tools);
    return agent;
  }

  /**
   * Process a conversation history and return the agent's response
   * @param messages - Conversation history
   * @param userId - User ID for context
   * @param options - Optional configuration for session state, persistence, and events
   */
  async runAgent(
    messages: Message[],
    _userId: string,
    options?: {
      sessionState?: SessionState;
      persistState?: (
        state: SessionState,
        status?: SessionState["status"]
      ) => Promise<void>;
      onEvent?: AgentEventCallback;
      approvals?: Array<{ approvalId: string; approved: boolean }>;
    }
  ): Promise<AgentResponseWithState> {
    return super.runAgent(messages, _userId, options);
  }
}
