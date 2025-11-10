import { getToolsOpenAI } from "@gmail-agents/arcade";
import { Agent as OpenAIAgent, run } from "@openai/agents";
import { Agent } from "./openai-agent.js";
import type {
  AgentConfig,
  AgentEventCallback,
  AgentResponse,
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
}

/**
 * React agent that extends the base Agent with tool-calling capabilities
 * Uses Arcade tools via the getToolsOpenAI function
 */
export class ReactAgent extends Agent {
  private toolkits: string[];
  private tools: string[];
  private toolLimit: number;

  constructor(config: ReactAgentConfig = {}) {
    super(config);
    this.toolkits = config.toolkits ?? [];
    this.tools = config.tools ?? [];
    this.toolLimit = config.toolLimit ?? DEFAULT_TOOL_LIMIT;
  }

  /**
   * Process a conversation with tool-calling support
   * @param messages - Conversation history
   * @param userId - User ID for context and tool authorization
   * @param options - Optional configuration for session state, persistence, and events
   */
  async runAgent(
    messages: Message[],
    userId: string,
    options?: {
      sessionState?: SessionState;
      persistState?: (
        state: SessionState,
        status?: SessionState["status"]
      ) => Promise<void>;
      onEvent?: AgentEventCallback;
    }
  ): Promise<AgentResponseWithState> {
    const { sessionState, persistState, onEvent } = options ?? {};
    try {
      const openaiTools = await this.loadTools(userId);
      const input = this.prepareInput(messages);
      const agentWithTools = this.createAgentWithTools(openaiTools);
      const result = await run(agentWithTools, input);

      return await this.buildResponse(
        result,
        sessionState,
        persistState,
        onEvent
      );
    } catch (error) {
      return this.handleReactAgentError(error, onEvent);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: Tools from OpenAI library require any type
  private async loadTools(userId: string): Promise<any[]> {
    if (this.toolkits.length === 0 && this.tools.length === 0) {
      return [];
    }

    try {
      return await getToolsOpenAI({
        toolkits: this.toolkits,
        tools: this.tools,
        limit: this.toolLimit,
        userId,
      });
    } catch (_error) {
      // Continue without tools rather than failing
      return [];
    }
  }

  private prepareInput(messages: Message[]): string {
    const nonSystemMessages = messages.filter((msg) => msg.role !== "system");

    if (nonSystemMessages.length === 0) {
      throw new Error("No messages provided");
    }

    const conversationParts = this.buildConversationParts(nonSystemMessages);
    const lastUserMessage = nonSystemMessages
      .filter((m) => m.role === "user")
      .pop();

    if (!lastUserMessage) {
      throw new Error("No user message found in conversation");
    }

    if (conversationParts.length > 1) {
      const context = conversationParts.slice(0, -1).join("\n");
      return `${context}\n\nUser: ${lastUserMessage.content}`;
    }

    return lastUserMessage.content;
  }

  // biome-ignore lint/suspicious/noExplicitAny: Tools from OpenAI library require any type
  private createAgentWithTools(tools: any[]): OpenAIAgent {
    return new OpenAIAgent({
      name: this.getConfig().agentDescription,
      instructions: this.getConfig().systemInstructions,
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  private async buildResponse(
    result: { finalOutput: unknown; usage?: unknown },
    sessionState: SessionState | undefined,
    persistState:
      | ((
          stateToSave: SessionState,
          status?: SessionState["status"]
        ) => Promise<void>)
      | undefined,
    onEvent: AgentEventCallback | undefined
  ): Promise<AgentResponseWithState> {
    const finalOutput =
      typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput);

    const metadata = this.extractMetadata(result);
    const state = this.getOrCreateState(sessionState);

    this.emitEvent(onEvent, {
      type: "state_updated",
      state,
    });

    await this.persistIfNeeded(persistState, state);

    this.emitEvent(onEvent, {
      type: "complete",
      state,
      data: {
        content: finalOutput,
        metadata,
      },
    });

    return {
      content: finalOutput,
      metadata,
      sessionState: state,
      status: state.status || "active",
    };
  }

  private extractMetadata(result: {
    usage?: unknown;
  }): AgentResponse["metadata"] {
    const metadata: AgentResponse["metadata"] = {
      model: this.getConfig().model,
    };

    if (result && typeof result === "object" && "usage" in result) {
      const usage = result.usage as { totalTokens?: number } | undefined;
      if (usage?.totalTokens) {
        metadata.tokensUsed = usage.totalTokens;
      }
    }

    return metadata;
  }

  private getOrCreateState(sessionState?: SessionState): SessionState {
    return (
      sessionState || {
        currentStep: 0,
        stepData: {},
        status: "active",
      }
    );
  }

  private async persistIfNeeded(
    persistState:
      | ((
          stateToSave: SessionState,
          status?: SessionState["status"]
        ) => Promise<void>)
      | undefined,
    state: SessionState
  ): Promise<void> {
    if (persistState) {
      try {
        await persistState(state, state.status || "active");
      } catch (_error) {
        // Don't throw - state persistence failure shouldn't break the agent response
      }
    }
  }

  private handleReactAgentError(
    error: unknown,
    onEvent?: AgentEventCallback
  ): never {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    this.emitEvent(onEvent, {
      type: "error",
      error: errorMessage,
    });

    if (error instanceof Error) {
      throw new Error(`React agent processing failed: ${error.message}`);
    }
    throw new Error("React agent processing failed with unknown error");
  }

  /**
   * Update the React agent configuration
   */
  updateConfig(config: Partial<ReactAgentConfig>): void {
    super.updateConfig(config);

    // Update tool-specific config
    if (config.toolkits !== undefined) {
      this.toolkits = config.toolkits;
    }
    if (config.tools !== undefined) {
      this.tools = config.tools;
    }
    if (config.toolLimit !== undefined) {
      this.toolLimit = config.toolLimit;
    }
  }

  /**
   * Get the current toolkits
   */
  getToolkits(): string[] {
    return [...this.toolkits];
  }

  /**
   * Get the current tools
   */
  getTools(): string[] {
    return [...this.tools];
  }
}
