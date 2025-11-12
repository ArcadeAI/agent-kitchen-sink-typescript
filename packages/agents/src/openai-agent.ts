import {
  type AgentInputItem,
  assistant,
  type FunctionTool,
  Agent as OpenAIAgent,
  Runner,
  RunState,
  type RunToolApprovalItem,
  user,
} from "@openai/agents";
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
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
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
  protected async emitToolCallCompleted(
    onEvent: AgentEventCallback | undefined,
    options: {
      toolName: string;
      result: unknown;
      state?: SessionState;
      step?: string;
      stepIndex?: number;
    }
  ): Promise<void> {
    await this.emitEvent(onEvent, {
      type: "tool_call_completed",
      data: { toolName: options.toolName, result: options.result },
      state: options.state,
      step: options.step,
      stepIndex: options.stepIndex,
    });
  }

  /**
   * Helper method to emit events for tool execution results
   * Extracts tool outputs from the run state and emits them as events
   */
  protected async emitToolExecutionResults(
    onEvent: AgentEventCallback | undefined,
    result: any,
    state?: SessionState
  ): Promise<void> {
    // Get the state data via toJSON() which provides the generatedItems
    if (!result?.state || typeof result.state.toJSON !== "function") {
      return;
    }

    const stateData = result.state.toJSON();
    if (!stateData?.generatedItems) {
      return;
    }

    // Extract tool execution results from the state
    const generatedItems = stateData.generatedItems || [];

    for (const item of generatedItems) {
      // Emit events for tool call outputs (execution results)
      if (item.type === "tool_call_output_item" && item.rawItem) {
        const toolName = item.rawItem.name || "unknown_tool";
        const output = item.output || item.rawItem.output;

        await this.emitEvent(onEvent, {
          type: "tool_call_completed",
          data: {
            toolName,
            result: output,
            callId: item.rawItem.callId,
          },
          state,
        });
      }
    }
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
    const { sessionState, persistState, onEvent, approvals } = options ?? {};

    try {
      // Check if we're resuming from a saved RunState
      const savedRunState = await this.getOpenAIAgentState(
        this.prepareSessionState(sessionState)
      );

      // If we have approvals and a saved run state, apply the approvals to the run state
      let input: AgentInputItem[] | RunState<any, any>;
      if (savedRunState && approvals && approvals.length > 0) {
        const interruptions = savedRunState.getInterruptions();

        // Track which interruptions were handled
        const handledIds = new Set<string>();

        for (const item of interruptions as RunToolApprovalItem[]) {
          // For each interruption, we will then check if the decision is to approve or reject the tool call
          if (item.type === "tool_approval_item" && "callId" in item.rawItem) {
            const callId = item.rawItem.callId;
            const approval = approvals.find(
              (approval) => approval.approvalId === callId
            );

            if (approval?.approved) {
              savedRunState.approve(item);
              handledIds.add(callId);
            } else if (approval?.approved === false) {
              savedRunState.reject(item);
              handledIds.add(callId);
            }
          }
        }

        // All interruptions have been handled, clear the saved state and continue
        const state = this.prepareSessionState(sessionState);
        state.stepData.OpenAIAgentState = undefined;
        await this.persistStateIfNeeded(persistState, state);
        input = savedRunState;
      } else {
        input = this.prepareConversationInput(messages);
      }

      const runner = new Runner();
      const result = await runner.run(this.openaiAgent, input);

      if (result.interruptions.length > 0) {
        // If the run resulted in one or more interruptions, we will store the current state in the database
        const state = this.prepareSessionState(sessionState);

        // Store the RunState so we can resume later
        const runStateString = await result.state.toString();
        state.stepData.OpenAIAgentState = runStateString;

        const status: SessionState["status"] = "waiting_input";
        state.status = status;

        // Persist the state
        await this.persistStateIfNeeded(persistState, state);

        // Emit any tool execution results that happened before this interruption
        // This allows the UI to show errors or results from previous tool calls
        await this.emitToolExecutionResults(onEvent, result, state);

        // We will return all the interruptions as approval requests to the UI/client so it can generate
        // the UI for approvals
        // We will also still return the history that contains the tool calls and potentially any interim
        // text response the agent might have generated (like announcing that it's calling a function)
        await this.emitWaitingInput(onEvent, {
          data: {
            approvals: result.interruptions
              .filter((item) => item.type === "tool_approval_item")
              .map((item) => item.toJSON()),
          },
          state,
          step: "waiting_input",
        });

        return {
          content: "Waiting for tool approval",
          metadata: {},
          sessionState: state,
          status,
        };
      }

      const finalOutput = this.extractFinalOutput(result);
      const metadata = this.buildMetadata(result);
      const state = this.prepareSessionState(sessionState);

      await this.emitEvent(onEvent, {
        type: "state_updated",
        state,
      });

      await this.persistStateIfNeeded(persistState, state);

      await this.emitEvent(onEvent, {
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
      return await this.handleAgentError(error, onEvent);
    }
  }

  private async getOpenAIAgentState(
    sessionState: SessionState
  ): Promise<RunState<any, any> | undefined> {
    if (sessionState.stepData.OpenAIAgentState !== undefined) {
      return await RunState.fromString(
        this.openaiAgent,
        sessionState.stepData.OpenAIAgentState as string
      );
    }
  }

  private prepareConversationInput(
    messages: Message[]
  ): AgentInputItem[] | RunState<any, any> {
    const inputItems: AgentInputItem[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        inputItems.push(user(message.content));
      } else if (message.role === "assistant") {
        inputItems.push(assistant(message.content));
      }
    }
    return inputItems;
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

  private async handleAgentError(
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

  addTools(tools: FunctionTool[]): void {
    this.openaiAgent.tools = [...(this.openaiAgent.tools || []), ...tools];
  }
}
