import {
  getToolsOpenAIFormatted,
  type OpenAIFormattedTool,
} from "@gmail-agents/arcade";
import OpenAI from "openai";
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
 * Pending tool call that requires approval
 */
type PendingToolCall = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  tool: OpenAIFormattedTool;
};

/**
 * OpenRouter agent configuration
 */
export interface OpenRouterAgentConfig extends AgentConfig {
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
 * Raw agent implementation using OpenRouter via OpenAI SDK
 * Does not rely on @openai/agents library - implements tool calling manually
 */
export class OpenRouterAgent extends BaseAgent {
  private readonly openaiClient: OpenAI;
  private readonly tools: OpenAIFormattedTool[] = [];
  private readonly toolkits: string[];
  private readonly toolLimit: number;
  private readonly userId?: string;

  constructor(config: OpenRouterAgentConfig = {}) {
    super({
      ...config,
      model: config.model ?? "moonshotai/kimi-k2-thinking",
    });
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY environment variable is required");
    }

    this.toolkits = config.toolkits ?? [];
    this.toolLimit = config.toolLimit ?? 30;
    this.userId = config.userId;

    // Initialize OpenAI client with OpenRouter configuration
    const headers: Record<string, string> = {};
    if (process.env.OPENROUTER_HTTP_REFERER) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
    }
    if (process.env.OPENROUTER_X_TITLE) {
      headers["X-Title"] = process.env.OPENROUTER_X_TITLE;
    } else {
      headers["X-Title"] = "Gmail Agents";
    }

    this.openaiClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
    });
  }

  /**
   * Static factory method to create an OpenRouterAgent with tools initialized
   */
  static async create(
    config: OpenRouterAgentConfig = {}
  ): Promise<OpenRouterAgent> {
    const agent = new OpenRouterAgent(config);
    if (agent.userId && (agent.toolkits.length > 0 || config.tools)) {
      const tools = await getToolsOpenAIFormatted({
        toolkits: agent.toolkits,
        tools: config.tools,
        limit: agent.toolLimit,
        userId: agent.userId,
      });
      agent.tools = tools;
    }
    return agent;
  }

  /**
   * Build metadata from completion
   */
  private buildMetadata(
    completion: OpenAI.Chat.Completions.ChatCompletion
  ): AgentResponse["metadata"] {
    const metadata: AgentResponse["metadata"] = {
      model: this.config.model,
    };

    if (completion.usage) {
      metadata.tokensUsed =
        completion.usage.total_tokens || completion.usage.completion_tokens;
      if (completion.choices[0]?.finish_reason) {
        metadata.finishReason = completion.choices[0].finish_reason;
      }
    }

    return metadata;
  }

  /**
   * Convert messages to OpenAI format
   */
  private prepareMessages(
    messages: Message[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === "user") {
        return { role: "user", content: msg.content };
      }
      if (msg.role === "assistant") {
        return { role: "assistant", content: msg.content };
      }
      if (msg.role === "system") {
        return { role: "system", content: msg.content };
      }
      return { role: "user", content: msg.content };
    });
  }

  /**
   * Get tools in OpenAI format
   */
  private getOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.tools.map((tool) => tool.definition);
  }

  /**
   * Find tool by name
   */
  private findTool(name: string): OpenAIFormattedTool | undefined {
    return this.tools.find(
      (t) => t.definition.function.name === name || t.qualifiedName === name
    );
  }

  /**
   * Process a conversation history and return the agent's response
   */
  async runAgent(
    messages: Message[],
    _userId: string,
    options?: AgentRunOptions
  ): Promise<AgentResponseWithState> {
    const { sessionState, persistState, onEvent, approvals } = options ?? {};
    const state = this.prepareSessionState(sessionState);

    try {
      // Check if we're resuming from pending tool calls
      const pendingToolCalls = this.getPendingToolCalls(state);
      const hasPendingCalls = pendingToolCalls.length > 0;

      // If we have approvals and pending calls, process them
      if (hasPendingCalls && approvals && approvals.length > 0) {
        const approvedCalls: PendingToolCall[] = [];
        const rejectedCalls: string[] = [];

        for (const pending of pendingToolCalls) {
          const approval = approvals.find((a) => a.approvalId === pending.id);
          if (approval?.approved) {
            approvedCalls.push(pending);
          } else if (approval?.approved === false) {
            rejectedCalls.push(pending.id);
          }
        }

        // Clear pending calls from state
        state.stepData.pendingToolCalls = undefined;

        // Execute approved calls
        const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] =
          [];
        for (const call of approvedCalls) {
          await this.emitToolCallStarted(onEvent, {
            toolName: call.toolName,
            callId: call.id,
            arguments: call.arguments,
            state,
          });

          try {
            const result = await call.tool.execute(call.arguments);
            await this.emitToolCallCompleted(onEvent, {
              toolName: call.toolName,
              result,
              callId: call.id,
              state,
            });

            toolResults.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            });
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            await this.emitToolCallCompleted(onEvent, {
              toolName: call.toolName,
              result: { error: errorMsg },
              callId: call.id,
              state,
            });

            toolResults.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: errorMsg }),
            });
          }
        }

        // Add tool results to messages and continue
        const updatedMessages = [
          ...this.prepareMessages(messages),
          ...toolResults,
        ];

        return await this.continueConversation(updatedMessages, state, {
          persistState,
          onEvent,
        });
      }

      // Normal flow: prepare messages with system instruction
      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          {
            role: "system",
            content: this.config.systemInstructions,
          },
          ...this.prepareMessages(messages),
        ];

      return await this.continueConversation(openaiMessages, state, {
        persistState,
        onEvent,
      });
    } catch (error) {
      return await this.handleAgentError(error, onEvent);
    }
  }

  /**
   * Continue conversation with OpenAI API
   */
  private async continueConversation(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    state: SessionState,
    options: {
      persistState?: (
        state: SessionState,
        status?: SessionState["status"]
      ) => Promise<void>;
      onEvent?: AgentEventCallback;
    }
  ): Promise<AgentResponseWithState> {
    const { persistState, onEvent } = options;

    const tools = this.getOpenAITools();
    const completion = await this.openaiClient.chat.completions.create({
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      tools: tools.length > 0 ? tools : undefined,
    });

    const assistantMessage = completion.choices[0]?.message;

    if (!assistantMessage) {
      throw new Error("No response from model");
    }

    // Check for tool calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const pendingToolCalls: PendingToolCall[] = [];
      const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] =
        [];

      for (const toolCall of assistantMessage.tool_calls) {
        // Extract function name and arguments from tool call
        let functionName: string | null = null;
        let functionArgs = "{}";

        if ("function" in toolCall) {
          functionName = toolCall.function.name;
          functionArgs =
            typeof toolCall.function.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments || {});
        }

        if (!functionName) {
          continue;
        }

        const tool = this.findTool(functionName);
        if (!tool) {
          // Tool not found - return error
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: `Tool ${functionName} not found`,
            }),
          });
          continue;
        }

        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(functionArgs);
        } catch {
          parsedArgs = {};
        }

        // Check if tool needs approval
        if (tool.needsApproval) {
          pendingToolCalls.push({
            id: toolCall.id,
            toolName: functionName,
            arguments: parsedArgs,
            tool,
          });
        } else {
          // Execute immediately
          await this.emitToolCallStarted(onEvent, {
            toolName: functionName,
            callId: toolCall.id,
            arguments: parsedArgs,
            state,
          });

          try {
            const result = await tool.execute(parsedArgs);
            await this.emitToolCallCompleted(onEvent, {
              toolName: functionName,
              result,
              callId: toolCall.id,
              state,
            });

            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            });
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            await this.emitToolCallCompleted(onEvent, {
              toolName: functionName,
              result: { error: errorMsg },
              callId: toolCall.id,
              state,
            });

            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: errorMsg }),
            });
          }
        }
      }

      // If there are pending approvals, save state and return
      if (pendingToolCalls.length > 0) {
        state.stepData.pendingToolCalls = pendingToolCalls.map((call) => ({
          id: call.id,
          toolName: call.toolName,
          arguments: call.arguments,
          qualifiedName: call.tool.qualifiedName,
        }));

        state.status = "waiting_input";

        await this.persistStateIfNeeded(persistState, state);

        // Emit waiting input event with approval requests
        await this.emitWaitingInput(onEvent, {
          data: {
            approvals: pendingToolCalls.map((call) => ({
              callId: call.id,
              toolName: call.toolName,
              arguments: call.arguments,
              qualifiedName: call.tool.qualifiedName,
            })),
          },
          state,
          step: "waiting_input",
        });

        return {
          content: "Waiting for tool approval",
          metadata: {},
          sessionState: state,
          status: "waiting_input",
        };
      }

      // All tools executed, continue conversation with results
      const updatedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          ...messages,
          {
            role: "assistant",
            content: assistantMessage.content || null,
            tool_calls: assistantMessage.tool_calls,
          },
          ...toolResults,
        ];

      return await this.continueConversation(updatedMessages, state, {
        persistState,
        onEvent,
      });
    }

    // No tool calls - return final response
    const finalOutput = assistantMessage.content || "";
    const metadata = this.buildMetadata(completion);

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
  }

  /**
   * Get pending tool calls from session state
   */
  private getPendingToolCalls(state: SessionState): PendingToolCall[] {
    const pending = state.stepData.pendingToolCalls;
    if (!Array.isArray(pending)) {
      return [];
    }

    return pending
      .map((call: unknown) => {
        if (
          typeof call === "object" &&
          call !== null &&
          "id" in call &&
          "toolName" in call &&
          "qualifiedName" in call &&
          "arguments" in call
        ) {
          const callObj = call as {
            id: string;
            toolName: string;
            qualifiedName: string;
            arguments: Record<string, unknown>;
          };
          const tool = this.findTool(callObj.qualifiedName);
          if (tool) {
            return {
              id: callObj.id,
              toolName: callObj.toolName,
              arguments: callObj.arguments || {},
              tool,
            };
          }
        }
        return null;
      })
      .filter((call): call is PendingToolCall => call !== null);
  }
}
