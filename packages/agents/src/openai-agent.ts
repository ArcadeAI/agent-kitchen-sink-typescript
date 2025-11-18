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
import { BaseAgent } from "./base-agent.js";
import type {
  AgentConfig,
  AgentEventCallback,
  AgentResponse,
  AgentResponseWithState,
  AgentRunOptions,
  Message,
  SessionState,
} from "./types.js";

/**
 * Base agent class that handles conversation history and LLM interactions
 * Uses the @openai/agents framework internally
 */
export class OpenAISDKAgent extends BaseAgent {
  protected openaiAgent: OpenAIAgent;

  constructor(config: AgentConfig = {}) {
    super(config);
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    // Create the OpenAI Agents SDK agent instance
    this.openaiAgent = new OpenAIAgent({
      name: "Assistant",
      instructions: this.config.systemInstructions,
    });
  }

  /**
   * Emit events for newly generated run items in the current turn
   */
  protected async emitEventsForNewItems(
    newItems: unknown[] | undefined,
    state: SessionState,
    onEvent: AgentEventCallback | undefined
  ): Promise<void> {
    if (!Array.isArray(newItems) || newItems.length === 0) {
      return;
    }

    for (const candidate of newItems) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const item = candidate as { type?: string };

      switch (item.type) {
        case "tool_call_item": {
          const { toolName, callId, args } =
            this.extractToolCallDetails(candidate);
          await this.emitToolCallStarted(onEvent, {
            toolName,
            callId,
            arguments: args,
            state,
          });
          break;
        }
        case "tool_call_output_item": {
          const { toolName, callId, output, args } =
            this.extractToolCallOutputDetails(candidate);
          await this.emitToolCallCompleted(onEvent, {
            toolName,
            result: output,
            callId,
            arguments: args,
            state,
          });
          break;
        }
        default:
          break;
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
    options?: AgentRunOptions
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

        await this.emitEventsForNewItems(result.newItems, state, onEvent);

        // Persist the state
        await this.persistStateIfNeeded(persistState, state);

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

      await this.emitEventsForNewItems(result.newItems, state, onEvent);

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

  /**
   * Update the agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    super.updateConfig(config);

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

  private extractToolCallDetails(item: unknown): {
    toolName: string;
    callId?: string;
    args?: unknown;
  } {
    const rawItem = this.getRawRunItem(item);
    return {
      toolName: this.getToolName(rawItem),
      callId: this.getToolCallId(rawItem),
      args: this.getToolCallArguments(rawItem),
    };
  }

  private extractToolCallOutputDetails(item: unknown): {
    toolName: string;
    callId?: string;
    output: unknown;
    args?: unknown;
  } {
    const rawItem = this.getRawRunItem(item);
    const output =
      (item as { output?: unknown })?.output ??
      (rawItem && typeof rawItem === "object" && "output" in rawItem
        ? (rawItem as { output?: unknown }).output
        : undefined);

    return {
      toolName: this.getToolName(rawItem),
      callId: this.getToolCallId(rawItem),
      output,
      args: this.getToolCallArguments(rawItem),
    };
  }

  private getRawRunItem(item: unknown): Record<string, unknown> | undefined {
    if (!item || typeof item !== "object") {
      return;
    }

    const rawItem = (item as { rawItem?: unknown }).rawItem;
    if (rawItem && typeof rawItem === "object") {
      return rawItem as Record<string, unknown>;
    }

    return;
  }

  private getToolName(rawItem?: Record<string, unknown>): string {
    if (!rawItem) {
      return "unknown_tool";
    }

    const candidates: unknown[] = [
      (rawItem as { name?: unknown }).name,
      (rawItem as { function?: { name?: unknown } }).function?.name,
      (rawItem as { tool?: { name?: unknown } }).tool?.name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }

    return "unknown_tool";
  }

  private getToolCallId(rawItem?: Record<string, unknown>): string | undefined {
    if (!rawItem) {
      return;
    }

    const candidates: unknown[] = [
      (rawItem as { callId?: unknown }).callId,
      (rawItem as { id?: unknown }).id,
      (rawItem as { toolCallId?: unknown }).toolCallId,
      (rawItem as { call?: { id?: unknown } }).call?.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }

    return;
  }

  private getToolCallArguments(rawItem?: Record<string, unknown>): unknown {
    if (!rawItem) {
      return;
    }

    const candidateValues: unknown[] = [];

    if ("arguments" in rawItem) {
      candidateValues.push((rawItem as { arguments?: unknown }).arguments);
    }

    const rawFunction = (
      rawItem as {
        function?: { arguments?: unknown };
      }
    ).function;
    if (rawFunction && typeof rawFunction === "object") {
      candidateValues.push(rawFunction.arguments);
    }

    const rawCall = (
      rawItem as {
        call?: { arguments?: unknown };
      }
    ).call;
    if (rawCall && typeof rawCall === "object") {
      candidateValues.push(rawCall.arguments);
    }

    for (const candidate of candidateValues) {
      if (candidate === undefined || candidate === null) {
        continue;
      }

      if (typeof candidate === "string") {
        try {
          return JSON.parse(candidate);
        } catch (_error) {
          return candidate;
        }
      }

      return candidate;
    }

    return;
  }
}
