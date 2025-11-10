import { Agent as OpenAIAgent, run } from "@openai/agents";
import { Agent } from "./openai-agent.js";
import type {
  AgentConfig,
  AgentResponse,
  AgentResponseWithState,
  Message,
  SessionState,
  AgentEventCallback,
} from "./types.js";
import { getToolsOpenAI } from "@gmail-agents/arcade";

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
    this.toolLimit = config.toolLimit ?? 30;
  }

  /**
   * Process a conversation with tool-calling support
   * @param messages - Conversation history
   * @param userId - User ID for context and tool authorization
   * @param sessionState - Optional session state for resuming conversations
   * @param persistState - Optional callback to persist state when it changes
   * @param onEvent - Optional callback to receive events during execution
   */
  async runAgent(
    messages: Message[],
    userId: string,
    sessionState?: SessionState,
    persistState?: (
      state: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>,
    onEvent?: AgentEventCallback
  ): Promise<AgentResponseWithState> {
    try {
      console.log("Running React agent with messages", messages);

      // Load tools from Arcade if any toolkits or tools are configured
      let openaiTools: any[] = [];
      if (this.toolkits.length > 0 || this.tools.length > 0) {
        try {
          openaiTools = await getToolsOpenAI({
            toolkits: this.toolkits,
            tools: this.tools,
            limit: this.toolLimit,
            userId: userId,
          });
          console.log(`Loaded ${openaiTools.length} tools from Arcade`);
        } catch (error) {
          console.error("Failed to load tools:", error);
          // Continue without tools rather than failing
        }
      }

      // Filter out system messages from the history as they're handled by instructions
      const nonSystemMessages = messages.filter((msg) => msg.role !== "system");

      // Validate we have messages
      if (nonSystemMessages.length === 0) {
        throw new Error("No messages provided");
      }

      // Build conversation context from messages
      const conversationParts: string[] = [];
      for (const msg of nonSystemMessages) {
        if (msg.role === "user") {
          conversationParts.push(`User: ${msg.content}`);
        } else if (msg.role === "assistant") {
          conversationParts.push(`Assistant: ${msg.content}`);
        }
      }

      // Use the last user message as the primary input
      const lastUserMessage = nonSystemMessages
        .filter((m) => m.role === "user")
        .pop();

      if (!lastUserMessage) {
        throw new Error("No user message found in conversation");
      }

      // If there's conversation history, include it in the input
      let input: string;
      if (conversationParts.length > 1) {
        const context = conversationParts.slice(0, -1).join("\n");
        input = `${context}\n\nUser: ${lastUserMessage.content}`;
      } else {
        input = lastUserMessage.content;
      }

      // Create a new agent instance with tools
      const agentWithTools = new OpenAIAgent({
        name: this.getConfig().agentDescription,
        instructions: this.getConfig().systemInstructions,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
      });

      // Run the agent with the input
      const result = await run(agentWithTools, input);

      // Extract the final output
      const finalOutput =
        typeof result.finalOutput === "string"
          ? result.finalOutput
          : JSON.stringify(result.finalOutput);

      // Extract metadata from the result if available
      const metadata: AgentResponse["metadata"] = {
        model: this.getConfig().model,
      };

      // Try to extract usage information from the result if available
      if (result && typeof result === "object" && "usage" in result) {
        const usage = result.usage as { totalTokens?: number } | undefined;
        if (usage?.totalTokens) {
          metadata.tokensUsed = usage.totalTokens;
        }
      }

      const state: SessionState = sessionState || {
        currentStep: 0,
        stepData: {},
        status: "active",
      };

      // Emit state updated event
      this.emitEvent(onEvent, {
        type: "state_updated",
        state,
      });

      // Persist state if callback provided
      if (persistState) {
        try {
          await persistState(state, state.status || "active");
        } catch (error) {
          console.error("Failed to persist state:", error);
          // Don't throw - state persistence failure shouldn't break the agent response
        }
      }

      // Emit completion event
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
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Emit error event
      this.emitEvent(onEvent, {
        type: "error",
        error: errorMessage,
      });

      if (error instanceof Error) {
        throw new Error(`React agent processing failed: ${error.message}`);
      }
      throw new Error("React agent processing failed with unknown error");
    }
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
    if ((config as ReactAgentConfig).toolLimit !== undefined) {
      this.toolLimit = (config as ReactAgentConfig).toolLimit!;
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
