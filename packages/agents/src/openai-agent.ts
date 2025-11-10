import { Agent as OpenAIAgent, run } from "@openai/agents";
import type {
  AgentConfig,
  AgentEvent,
  AgentEventCallback,
  AgentResponse,
  AgentResponseWithState,
  Message,
  SessionState,
} from "./types.js";
import { AuthPattern } from "./types.js";

/**
 * Base agent class that handles conversation history and LLM interactions
 * Uses the @openai/agents framework internally
 */
export class Agent {
  protected openaiAgent: OpenAIAgent;
  private config: Required<AgentConfig>;
  public agentDescription: string;
  public integrations: string[];
  public authPattern: AuthPattern;
  public agentic: number;

  constructor(config: AgentConfig = {}) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    this.config = {
      model: config.model ?? "gpt-4o",
      systemInstructions:
        config.systemInstructions ?? "You are a helpful assistant.",
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1000,
      agentDescription: config.agentDescription ?? "",
      integrations: config.integrations ?? [],
      authPattern: config.authPattern ?? AuthPattern.JIT,
      agentic: config.agentic ?? 0.0,
    };

    // Initialize new fields
    this.agentDescription = config.agentDescription ?? "";
    this.integrations = config.integrations ?? [];
    this.authPattern = config.authPattern ?? AuthPattern.JIT;
    this.agentic = config.agentic ?? 0.0;

    // Create the OpenAI Agents SDK agent instance
    this.openaiAgent = new OpenAIAgent({
      name: "Assistant",
      instructions: this.config.systemInstructions,
    });
  }

  /**
   * Helper method to emit events
   */
  protected emitEvent(
    onEvent: AgentEventCallback | undefined,
    event: Omit<AgentEvent, "timestamp">
  ): void {
    if (onEvent) {
      const fullEvent: AgentEvent = {
        ...event,
        timestamp: Date.now(),
      };
      try {
        onEvent(fullEvent);
      } catch (_error) {}
    }
  }

  /**
   * Helper method to emit auth_required event
   */
  protected emitAuthRequired(
    onEvent: AgentEventCallback | undefined,
    data: Record<string, unknown>,
    state?: SessionState,
    step?: string,
    stepIndex?: number
  ): void {
    this.emitEvent(onEvent, {
      type: "auth_required",
      data,
      state,
      step,
      stepIndex,
      requiresExternalAction: true,
      resumable: true,
    });
  }

  /**
   * Helper method to emit waiting_user_input event
   */
  protected emitWaitingInput(
    onEvent: AgentEventCallback | undefined,
    data: Record<string, unknown>,
    state?: SessionState,
    step?: string,
    stepIndex?: number
  ): void {
    this.emitEvent(onEvent, {
      type: "waiting_user_input",
      data,
      state,
      step,
      stepIndex,
      requiresExternalAction: true,
      resumable: true,
    });
  }

  /**
   * Helper method to emit tool_call_started event
   */
  protected emitToolCallStarted(
    onEvent: AgentEventCallback | undefined,
    toolName: string,
    state?: SessionState,
    step?: string,
    stepIndex?: number
  ): void {
    this.emitEvent(onEvent, {
      type: "tool_call_started",
      data: { toolName },
      state,
      step,
      stepIndex,
    });
  }

  /**
   * Helper method to emit tool_call_completed event
   */
  protected emitToolCallCompleted(
    onEvent: AgentEventCallback | undefined,
    toolName: string,
    result: unknown,
    state?: SessionState,
    step?: string,
    stepIndex?: number
  ): void {
    this.emitEvent(onEvent, {
      type: "tool_call_completed",
      data: { toolName, result },
      state,
      step,
      stepIndex,
    });
  }

  /**
   * Process a conversation history and return the agent's response
   * @param messages - Conversation history
   * @param userId - User ID for context
   * @param sessionState - Optional session state for resuming conversations
   * @param persistState - Optional callback to persist state when it changes
   * @param onEvent - Optional callback to receive events during execution
   */
  async runAgent(
    messages: Message[],
    _userId: string,
    sessionState?: SessionState,
    persistState?: (
      state: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>,
    onEvent?: AgentEventCallback
  ): Promise<AgentResponseWithState> {
    try {
      // Filter out system messages from the history as they're handled by instructions
      const nonSystemMessages = messages.filter((msg) => msg.role !== "system");

      // Convert messages to a format suitable for the framework
      // If there are messages, construct the input from the conversation
      // Otherwise, use the last user message
      let input: string;
      if (nonSystemMessages.length === 0) {
        throw new Error("No messages provided");
      }

      // Build conversation context from messages
      // The framework's run() can handle string input, so we'll format the conversation
      const conversationParts: string[] = [];
      for (const msg of nonSystemMessages) {
        if (msg.role === "user") {
          conversationParts.push(`User: ${msg.content}`);
        } else if (msg.role === "assistant") {
          conversationParts.push(`Assistant: ${msg.content}`);
        }
      }

      // Use the last user message as the primary input, with context if needed
      const lastUserMessage = nonSystemMessages
        .filter((m) => m.role === "user")
        .pop();

      if (!lastUserMessage) {
        throw new Error("No user message found in conversation");
      }

      // If there's conversation history, include it in the input
      if (conversationParts.length > 1) {
        // Include previous conversation context
        const context = conversationParts.slice(0, -1).join("\n");
        input = `${context}\n\nUser: ${lastUserMessage.content}`;
      } else {
        input = lastUserMessage.content;
      }

      // Run the agent with the input
      const result = await run(this.openaiAgent, input);

      // Extract the final output
      const finalOutput =
        typeof result.finalOutput === "string"
          ? result.finalOutput
          : JSON.stringify(result.finalOutput);

      // Extract metadata from the result if available
      const metadata: AgentResponse["metadata"] = {
        model: this.config.model,
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
        } catch (_error) {
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
        throw new Error(`Agent processing failed: ${error.message}`);
      }
      throw new Error("Agent processing failed with unknown error");
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): Required<AgentConfig> {
    return { ...this.config };
  }

  /**
   * Update the agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };

    // Update new fields if provided
    if (config.agentDescription !== undefined) {
      this.agentDescription = config.agentDescription;
    }
    if (config.integrations !== undefined) {
      this.integrations = config.integrations;
    }
    if (config.authPattern !== undefined) {
      this.authPattern = config.authPattern;
    }
    if (config.agentic !== undefined) {
      this.agentic = config.agentic;
    }

    // Update the OpenAI agent's instructions if systemInstructions changed
    if (config.systemInstructions !== undefined) {
      this.openaiAgent = new OpenAIAgent({
        name: "Assistant",
        instructions: this.config.systemInstructions,
      });
    }
  }
}
