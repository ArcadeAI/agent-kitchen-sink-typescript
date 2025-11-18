import type { AuthEvent } from "@gmail-agents/arcade";
import arcadeClient, {
  authorizeTools,
  getTools,
  getToolsOpenAI,
} from "@gmail-agents/arcade";
import { Agent as OpenAIAgent, run } from "@openai/agents";
import { OpenAISDKAgent } from "../openai-agent.js";
import type {
  AgentConfig,
  AgentEventCallback,
  AgentResponseWithState,
  AgentRunOptions,
  Message,
  SessionState,
} from "../types.js";
import { AuthPattern } from "../types.js";
import type { Email } from "./types.js";

/**
 * Inbox summarizer agent that extends the base Agent class
 * Handles workflow-based email summarization
 * This agent is stateless - all state is passed in and returned
 */
export class InboxSummarizer extends OpenAISDKAgent {
  private readonly steps: readonly string[] = [
    "initialize-tools",
    "get-emails",
    "summarize-emails",
    "assemble-report",
    "free-chat",
  ] as const;

  constructor(config: AgentConfig = {}) {
    // Set default system instructions if not provided
    const defaultConfig: AgentConfig = {
      systemInstructions:
        "You are a helpful assistant that is specialized to talk about a person's inbox. You have access to a summary of the latest emails from the user, as well as access to tools that allow you to get more emails and interact with Slack.",
      agentDescription: "Summarizes and organizes emails from your inbox",
      integrations: ["Gmail", "Slack"],
      authPattern: AuthPattern.PRE_AUTH,
      agentic: 0.5,
      ...config,
    };

    super(defaultConfig);
  }

  async runAgent(
    messages: Message[],
    userId: string,
    options?: AgentRunOptions
  ): Promise<AgentResponseWithState> {
    const { sessionState, persistState, onEvent, approvals } = options ?? {};
    const state = this.initializeState(sessionState);
    const saveState = this.createStatePersister(persistState);

    // Run workflow steps until we reach free-chat
    const workflowResult = await this.executeWorkflowSteps(
      state,
      userId,
      onEvent,
      saveState
    );

    if (workflowResult) {
      return workflowResult;
    }

    // Execute free-chat phase
    state.status = "active";
    this.addTools(
      await getToolsOpenAI({
        tools: ["Gmail.ListEmails", "Gmail.SendEmail", "Slack.SendMessage"],
        userId,
      })
    );
    const chatResponse = await this.handleMessages(messages, userId, {
      state,
      persistState,
      onEvent,
      approvals,
    });

    await saveState(state, state.status || "active");

    return {
      ...chatResponse,
      sessionState: state,
      status: state.status,
    };
  }

  private initializeState(sessionState?: SessionState): SessionState {
    const state: SessionState = sessionState || {
      currentStep: 0,
      stepData: {},
      status: "active",
    };

    if (state.stepData.systemInstructions) {
      this.updateConfig({
        systemInstructions: state.stepData.systemInstructions as string,
      });
    }

    return state;
  }

  private createStatePersister(
    persistState?: (
      state: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>
  ) {
    return async (
      stateToSave: SessionState,
      status?: SessionState["status"]
    ) => {
      if (persistState) {
        try {
          await persistState(
            stateToSave,
            status || stateToSave.status || "active"
          );
        } catch (_error) {
          // Don't throw - state persistence failure shouldn't break the agent
        }
      }
    };
  }

  private async executeWorkflowSteps(
    state: SessionState,
    userId: string,
    onEvent: AgentEventCallback | undefined,
    saveState: (
      stateToSave: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>
  ): Promise<AgentResponseWithState | null> {
    let step = this.steps[state.currentStep];

    while (step && step !== "free-chat") {
      if (this.isStepCompleted(step, state)) {
        state.currentStep += 1;
        step = this.steps[state.currentStep];
        continue;
      }

      await this.emitStepStarted(onEvent, step, state);

      const stepResult = await this.runStep(step, userId, state, onEvent);

      if (stepResult.data) {
        state.stepData = { ...state.stepData, ...stepResult.data };
      }

      const waitResult = await this.handleStepWait(
        stepResult,
        step,
        state,
        saveState
      );
      if (waitResult) {
        return waitResult;
      }

      this.markStepCompleted(step, state);
      await this.emitStepCompleted(onEvent, step, state, stepResult.data);

      state.currentStep += 1;
      step = this.steps[state.currentStep];
    }

    return null;
  }

  private async emitStepStarted(
    onEvent: AgentEventCallback | undefined,
    step: string,
    state: SessionState
  ): Promise<void> {
    if (onEvent) {
      await onEvent({
        type: "step_started",
        step,
        stepIndex: state.currentStep,
        state,
        timestamp: Date.now(),
      });
    }
  }

  private async emitStepCompleted(
    onEvent: AgentEventCallback | undefined,
    step: string,
    state: SessionState,
    data?: Record<string, unknown>
  ): Promise<void> {
    if (onEvent) {
      await onEvent({
        type: "step_completed",
        step,
        stepIndex: state.currentStep,
        state,
        data,
        timestamp: Date.now(),
      });
    }
  }

  private async handleStepWait(
    stepResult: {
      needsWait?: boolean;
      status?: string;
      data?: Record<string, unknown>;
    },
    step: string,
    state: SessionState,
    saveState: (
      stateToSave: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>
  ): Promise<AgentResponseWithState | null> {
    if (stepResult.needsWait) {
      const status: SessionState["status"] =
        (stepResult.status as SessionState["status"]) || "waiting_auth";
      state.status = status;
      await saveState(state, status);
      return {
        content: `Waiting for ${step} to complete`,
        metadata: {},
        sessionState: state,
        status,
      };
    }
    return null;
  }

  private markStepCompleted(step: string, state: SessionState): void {
    state.stepData[`${step}_completed`] = true;
  }

  /**
   * Check if a step is already completed (idempotency check)
   */
  private isStepCompleted(step: string, state: SessionState): boolean {
    switch (step) {
      case "initialize-tools":
        return state.stepData.toolsInitialized === true;
      case "get-emails":
        return (
          Array.isArray(state.stepData.emails) &&
          (state.stepData.emails as Email[]).length > 0
        );
      case "summarize-emails":
        return (
          state.stepData.summaries !== undefined &&
          Object.keys(state.stepData.summaries as Record<string, string>)
            .length > 0
        );
      case "assemble-report":
        return state.stepData.reportAssembled === true;
      default:
        return false;
    }
  }

  /**
   * Run a specific step with state management
   */
  private async runStep(
    step: string,
    userId: string,
    state: SessionState,
    onEvent?: AgentEventCallback
  ): Promise<{
    data?: Record<string, unknown>;
    needsWait?: boolean;
    status?: string;
  }> {
    switch (step) {
      case "initialize-tools":
        return await this.initializeTools(userId, state, onEvent);
      case "get-emails":
        return await this.getEmails(userId, state, onEvent);
      case "summarize-emails":
        return await this.summarizeEmails(state);
      case "assemble-report":
        return this.assembleReport(state);
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  }

  assembleReport(_state: SessionState) {
    // This step simply injects the summaries of the latest emails into the LLM context
    const summaries = _state.stepData.summaries as Record<string, string>;
    const summariesXML = `<summaries>
${Object.entries(summaries)
  .map(([id, summary]) => `<summary id="${id}">\n${summary}\n</summary>`)
  .join("\n")}
</summaries>`;

    const systemInstructions = `
	You are a helpful assistant that is specialized to talk about a person's inbox. You have access to a summary of the latest emails from the user, as well as access to tools that allow you to get more emails and interact with Slack.

	Here is the summary of the latest emails from the user:
	${summariesXML}
	`;

    this.updateConfig({
      systemInstructions,
    });
    // Use state.stepData.summaries to assemble the report
    return {
      data: {
        reportAssembled: true,
        systemInstructions,
      },
    };
  }

  async initializeTools(
    userId: string,
    state: SessionState,
    onEvent?: AgentEventCallback
  ): Promise<{
    data?: Record<string, unknown>;
    needsWait?: boolean;
    status?: string;
  }> {
    const tools = await getTools({
      tools: ["Gmail.ListEmails", "Gmail.SendEmail", "Slack.SendMessage"],
      toolkits: ["GoogleCalendar"],
      limit: 80,
    });

    const authResult = await authorizeTools(
      tools,
      userId,
      async (authEvent: AuthEvent) => {
        // Convert auth event to agent event
        await this.emitAuthRequired(onEvent, {
          data: {
            providerId: authEvent.providerId,
            status: authEvent.status,
            url: authEvent.url,
            scopes: authEvent.scopes,
          },
          state,
          step: "initialize-tools",
          stepIndex: state.currentStep,
        });
      }
    );

    if (!authResult.completed) {
      return {
        needsWait: true,
        status: "waiting_auth",
      };
    }

    return {
      data: {
        toolsInitialized: true,
        tools: tools.map((t) => t.name),
      },
    };
  }

  async getEmails(
    userId: string,
    state: SessionState,
    onEvent?: AgentEventCallback
  ): Promise<{
    data?: Record<string, unknown>;
    needsWait?: boolean;
    status?: string;
  }> {
    // Emit tool call started event
    await this.emitToolCallStarted(onEvent, {
      toolName: "Gmail.ListEmails",
      state,
      step: "get-emails",
      stepIndex: state.currentStep,
    });

    // In this step we assume that auth was successful from
    // the initialize-tools step, so this tool execution should be successful
    const emails = await arcadeClient.tools.execute({
      tool_name: "Gmail.ListEmails",
      input: {
        n_emails: 10,
      },
      user_id: userId,
    });

    // TODO: Add pagination support for long lists
    const emailList =
      (emails.output?.value as { emails: Email[] })?.emails ?? [];

    // Emit tool call completed event
    await this.emitToolCallCompleted(onEvent, {
      toolName: "Gmail.ListEmails",
      result: { emailCount: emailList.length },
      state,
      step: "get-emails",
      stepIndex: state.currentStep,
    });

    return {
      data: {
        emails: emailList,
      },
    };
  }

  async summarizeEmails(state: SessionState): Promise<{
    data?: Record<string, unknown>;
  }> {
    const emails = (state.stepData.emails as Email[]) || [];
    const summaries: Record<string, string> = {};

    // Placeholder: create simple summaries
    const summarizer = new OpenAIAgent({
      name: "Email Summarizer",
      model: "gpt-4o-mini",
      instructions:
        "You are an expert at summarizing emails. Your task is to get an email and summarize it concisely in a few bullet points.",
    });

    await Promise.all(
      emails.map(async (email) => {
        const message = `The email is from ${email.from} to ${email.to} with the subject "${email.subject}". The email body is: ${email.body}`;
        const summary = await run(summarizer, message);
        summaries[email.id] = summary.finalOutput as string;
      })
    );

    return {
      data: {
        summaries,
      },
    };
  }

  /**
   * Process a conversation history and return the agent's response
   * Delegates to the base class's runAgent method
   */
  handleMessages(
    messages: Message[],
    userId: string,
    options: {
      state: SessionState;
      persistState?: (
        state: SessionState,
        status?: SessionState["status"]
      ) => Promise<void>;
      onEvent?: AgentEventCallback;
      approvals?: Array<{ approvalId: string; approved: boolean }>;
    }
  ): Promise<AgentResponseWithState> {
    return super.runAgent(messages, userId, options);
  }
}
