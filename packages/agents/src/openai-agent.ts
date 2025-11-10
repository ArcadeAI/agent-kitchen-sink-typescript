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

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_AGENTIC_LEVEL = 0.0;

/**
 * Base agent class that handles conversation history and LLM interactions
 * Uses the @openai/agents framework internally
 */
export class Agent {
  protected openaiAgent: OpenAIAgent;
  private config: Required<AgentConfig>;
  agentDescription: string;
  integrations: string[];
  authPattern: AuthPattern;
  agentic: number;

  constructor(config: AgentConfig = {}) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    this.config = {
      model: config.model ?? "gpt-4o",
      systemInstructions:
        config.systemInstructions ?? "You are a helpful assistant.",
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      agentDescription: config.agentDescription ?? "",
      integrations: config.integrations ?? [],
      authPattern: config.authPattern ?? AuthPattern.JIT,
      agentic: config.agentic ?? DEFAULT_AGENTIC_LEVEL,
    };

    // Initialize new fields
    this.agentDescription = config.agentDescription ?? "";
    this.integrations = config.integrations ?? [];
    this.authPattern = config.authPattern ?? AuthPattern.JIT;
    this.agentic = config.agentic ?? DEFAULT_AGENTIC_LEVEL;

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
      } catch (_error) {
        // Intentionally swallow errors from event callbacks to prevent agent failures
      }
    }
  }

  /**
   * Helper method to emit auth_required event
   */
  protected emitAuthRequired(
    onEvent: AgentEventCallback | undefined,
    options: {
      data: Record<string, unknown>;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): void {
    this.emitEvent(onEvent, {
      type: "auth_required",
      data: options.data,
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
      requiresExternalAction: true,
      resumable: true,
    });
  }

  /**
   * Helper method to emit waiting_user_input event
   */
  protected emitWaitingInput(
    onEvent: AgentEventCallback | undefined,
    options: {
      data: Record<string, unknown>;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): void {
    this.emitEvent(onEvent, {
      type: "waiting_user_input",
      data: options.data,
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
      requiresExternalAction: true,
      resumable: true,
    });
  }

  /**
   * Helper method to emit tool_call_started event
   */
  protected emitToolCallStarted(
    onEvent: AgentEventCallback | undefined,
    options: {
      toolName: string;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): void {
    this.emitEvent(onEvent, {
      type: "tool_call_started",
      data: { toolName: options.toolName },
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
    });
  }

  /**
   * Helper method to emit tool_call_completed event
   */
  protected emitToolCallCompleted(
    onEvent: AgentEventCallback | undefined,
    options: {
      toolName: string;
      result: unknown;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): void {
    this.emitEvent(onEvent, {
      type: "tool_call_completed",
      data: { toolName: options.toolName, result: options.result },
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
    });
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
    }
  ): Promise<AgentResponseWithState> {
    const { sessionState, persistState, onEvent } = options ?? {};

    try {
      const input = this.prepareConversationInput(messages);
      const result = await run(this.openaiAgent, input);
      const finalOutput = this.extractFinalOutput(result);
      const metadata = this.buildMetadata(result);
      const state = this.prepareSessionState(sessionState);

      this.emitEvent(onEvent, {
        type: "state_updated",
        state,
      });

      await this.persistStateIfNeeded(persistState, state);

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
      return this.handleAgentError(error, onEvent);
    }
  }

  private prepareConversationInput(messages: Message[]): string {
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

  protected buildConversationParts(messages: Message[]): string[] {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        parts.push(`User: ${msg.content}`);
      } else if (msg.role === "assistant") {
        parts.push(`Assistant: ${msg.content}`);
      }
    }
    return parts;
  }

  private extractFinalOutput(result: { finalOutput: unknown }): string {
    return typeof result.finalOutput === "string"
      ? result.finalOutput
      : JSON.stringify(result.finalOutput);
  }

  private buildMetadata(result: unknown): AgentResponse["metadata"] {
    const metadata: AgentResponse["metadata"] = {
      model: this.config.model,
    };

    if (result && typeof result === "object" && "usage" in result) {
      const usage = result.usage as { totalTokens?: number } | undefined;
      if (usage?.totalTokens) {
        metadata.tokensUsed = usage.totalTokens;
      }
    }

    return metadata;
  }

  private prepareSessionState(sessionState?: SessionState): SessionState {
    return (
      sessionState || {
        currentStep: 0,
        stepData: {},
        status: "active",
      }
    );
  }

  private async persistStateIfNeeded(
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

  private handleAgentError(
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
      throw new Error(`Agent processing failed: ${error.message}`);
    }
    throw new Error("Agent processing failed with unknown error");
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
