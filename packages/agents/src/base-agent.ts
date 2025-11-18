import type {
  AgentConfig,
  AgentEvent,
  AgentEventCallback,
  AgentResponseWithState,
  AgentRunOptions,
  Message,
  SessionState,
} from "./types.js";
import { AuthPattern } from "./types.js";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_AGENTIC_LEVEL = 0.0;

/**
 * Base agent interface that all agent implementations must follow
 */
export type Agent = {
  /**
   * Process a conversation history and return the agent's response
   */
  runAgent(
    messages: Message[],
    userId: string,
    options?: AgentRunOptions
  ): Promise<AgentResponseWithState>;

  /**
   * Get the current configuration
   */
  getConfig(): Required<AgentConfig>;

  /**
   * Update the agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void;

  /**
   * Agent description
   */
  agentDescription: string;

  /**
   * List of integrations this agent uses
   */
  integrations: string[];

  /**
   * Authentication pattern for the agent
   */
  authPattern: AuthPattern;

  /**
   * Agentic score (0-1) indicating how autonomous the agent is
   */
  agentic: number;
};

/**
 * Base agent class that provides shared functionality for all agent implementations
 * Handles event emission, session state management, and common utilities
 */
export abstract class BaseAgent implements Agent {
  protected config: Required<AgentConfig>;
  agentDescription: string;
  integrations: string[];
  authPattern: AuthPattern;
  agentic: number;

  constructor(config: AgentConfig = {}) {
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
  }

  /**
   * Abstract method that subclasses must implement to process messages
   */
  abstract runAgent(
    messages: Message[],
    userId: string,
    options?: AgentRunOptions
  ): Promise<AgentResponseWithState>;

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
  }

  /**
   * Helper method to emit events
   */
  protected async emitEvent(
    onEvent: AgentEventCallback | undefined,
    event: Omit<AgentEvent, "timestamp">
  ): Promise<void> {
    if (onEvent) {
      const fullEvent: AgentEvent = {
        ...event,
        timestamp: Date.now(),
      };
      try {
        await onEvent(fullEvent);
      } catch (_error) {
        // Intentionally swallow errors from event callbacks to prevent agent failures
      }
    }
  }

  /**
   * Helper method to emit auth_required event
   */
  protected async emitAuthRequired(
    onEvent: AgentEventCallback | undefined,
    options: {
      data: Record<string, unknown>;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
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
  protected async emitWaitingInput(
    onEvent: AgentEventCallback | undefined,
    options: {
      data: Record<string, unknown>;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
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
  protected async emitToolCallStarted(
    onEvent: AgentEventCallback | undefined,
    options: {
      toolName: string;
      callId?: string;
      arguments?: unknown;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
      type: "tool_call_started",
      data: {
        toolName: options.toolName,
        callId: options.callId,
        arguments: options.arguments,
      },
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
    });
  }

  /**
   * Helper method to emit tool_call_completed event
   */
  protected async emitToolCallCompleted(
    onEvent: AgentEventCallback | undefined,
    options: {
      toolName: string;
      result: unknown;
      callId?: string;
      arguments?: unknown;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
      type: "tool_call_completed",
      data: {
        toolName: options.toolName,
        result: options.result,
        callId: options.callId,
        arguments: options.arguments,
      },
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
    });
  }

  /**
   * Prepare session state with defaults
   */
  protected prepareSessionState(sessionState?: SessionState): SessionState {
    return (
      sessionState || {
        currentStep: 0,
        stepData: {},
        status: "active",
      }
    );
  }

  /**
   * Persist state if callback provided
   */
  protected async persistStateIfNeeded(
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

  /**
   * Handle agent errors
   */
  protected async handleAgentError(
    error: unknown,
    onEvent?: AgentEventCallback
  ): Promise<never> {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await this.emitEvent(onEvent, {
      type: "error",
      error: errorMessage,
    });

    if (error instanceof Error) {
      throw new Error(`Agent processing failed: ${error.message}`);
    }
    throw new Error("Agent processing failed with unknown error");
  }
}
