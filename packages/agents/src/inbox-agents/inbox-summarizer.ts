import type {
  AgentConfig,
  AgentResponseWithState,
  Message,
  SessionState,
  AgentEventCallback,
} from "../types.js";
import { Agent } from "../openai-agent.js";
import { AuthPattern } from "../types.js";
import type { Email } from "./types.js";
import arcadeClient, { getTools, authorizeTools } from "@gmail-agents/arcade";
import type { AuthEvent } from "@gmail-agents/arcade";

/**
 * Inbox summarizer agent that extends the base Agent class
 * Handles workflow-based email summarization
 * This agent is stateless - all state is passed in and returned
 */
export class InboxSummarizer extends Agent {
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
    sessionState?: SessionState,
    persistState?: (
      state: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>,
    onEvent?: AgentEventCallback
  ): Promise<AgentResponseWithState> {
    // Initialize or use provided session state
    const state: SessionState = sessionState || {
      currentStep: 0,
      stepData: {},
      status: "active",
    };

    // Restore custom system instructions if they exist in state
    if (state.stepData.systemInstructions) {
      this.updateConfig({
        systemInstructions: state.stepData.systemInstructions as string,
      });
    }

    // Helper to persist state and handle errors
    const saveState = async (
      stateToSave: SessionState,
      status?: SessionState["status"]
    ) => {
      if (persistState) {
        try {
          await persistState(
            stateToSave,
            status || stateToSave.status || "active"
          );
        } catch (error) {
          console.error("Failed to persist state:", error);
          // Don't throw - state persistence failure shouldn't break the agent
        }
      }
    };

    console.log("state", state);
    console.log("messages", messages);
    console.log("userId", userId);

    // Run workflow steps until we reach free-chat
    let step = this.steps[state.currentStep];
    while (step && step !== "free-chat") {
      console.log(`Running step: ${step} (step ${state.currentStep})`);

      // Check if step is already completed (idempotency check)
      if (this.isStepCompleted(step, state)) {
        console.log(`Step ${step} already completed, skipping`);
        state.currentStep++;
        step = this.steps[state.currentStep];
        continue;
      }

      // Emit step started event
      if (onEvent) {
        onEvent({
          type: "step_started",
          step,
          stepIndex: state.currentStep,
          state,
          timestamp: Date.now(),
        });
      }

      const stepResult = await this.runStep(step, userId, state, onEvent);

      // Update state with step results
      if (stepResult.data) {
        state.stepData = { ...state.stepData, ...stepResult.data };
      }

      // Check if step needs to wait (e.g., auth required)
      if (stepResult.needsWait) {
        const status: SessionState["status"] =
          (stepResult.status as SessionState["status"]) || "waiting_auth";
        state.status = status;
        // Save state before returning (important for interruptions)
        await saveState(state, status);
        return {
          content: `Waiting for ${step} to complete`,
          metadata: {},
          sessionState: state,
          status,
        };
      }

      // Mark step as completed
      state.stepData[`${step}_completed`] = true;

      // Emit step completed event
      if (onEvent) {
        onEvent({
          type: "step_completed",
          step,
          stepIndex: state.currentStep,
          state,
          data: stepResult.data,
          timestamp: Date.now(),
        });
      }

      state.currentStep++;
      step = this.steps[state.currentStep];
    }

    // Run the agentic portion (free chat)
    console.log("Free chat");
    state.status = "active";
    const chatResponse = await this.handleMessages(
      messages,
      userId,
      state,
      persistState,
      onEvent
    );

    // Save final state
    await saveState(state, state.status || "active");

    return {
      ...chatResponse,
      sessionState: state,
      status: state.status,
    };
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
        return this.getEmails(userId, state, onEvent);
      case "summarize-emails":
        return this.summarizeEmails(state);
      case "assemble-report":
        return this.assembleReport(state);
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  }

  async assembleReport(_state: SessionState) {
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
      systemInstructions: systemInstructions,
    });
    // Use state.stepData.summaries to assemble the report
    return {
      data: {
        reportAssembled: true,
        systemInstructions: systemInstructions,
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
    });

    const authResult = await authorizeTools(
      tools,
      userId,
      (authEvent: AuthEvent) => {
        // Convert auth event to agent event
        this.emitAuthRequired(
          onEvent,
          {
            providerId: authEvent.providerId,
            status: authEvent.status,
            url: authEvent.url,
            scopes: authEvent.scopes,
          },
          state,
          "initialize-tools",
          state.currentStep
        );
      }
    );

    console.log("authResult", authResult);

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
    console.log("calling the Arcade client to get emails");
    console.log("userId", userId);

    // Emit tool call started event
    this.emitToolCallStarted(
      onEvent,
      "Gmail.ListEmails",
      state,
      "get-emails",
      state.currentStep
    );

    // In this step we assume that auth was successful from
    // the initialize-tools step, so this tool execution should be successful
    const emails = await arcadeClient.tools.execute({
      tool_name: "Gmail.ListEmails",
      input: {
        n_emails: 10,
      },
      user_id: userId,
    });
    console.log("emails", emails);

    // TODO: Add pagination support for long lists
    const emailList =
      (emails.output?.value as { emails: Email[] })?.emails ?? [];

    // Emit tool call completed event
    this.emitToolCallCompleted(
      onEvent,
      "Gmail.ListEmails",
      { emailCount: emailList.length },
      state,
      "get-emails",
      state.currentStep
    );

    return {
      data: {
        emails: emailList,
      },
    };
  }

  async summarizeEmails(state: SessionState): Promise<{
    data?: Record<string, unknown>;
  }> {
    // TODO: Implement email summarization
    // Use state.stepData.emails to summarize
    console.log("summarizing emails", state.stepData.emails);
    const emails = (state.stepData.emails as Email[]) || [];
    const summaries: Record<string, string> = {};

    // Placeholder: create simple summaries
    for (const email of emails) {
      summaries[email.id] = `Summary of: ${email.subject}`;
    }

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
  async handleMessages(
    messages: Message[],
    userId: string,
    state: SessionState,
    persistState?: (
      state: SessionState,
      status?: SessionState["status"]
    ) => Promise<void>,
    onEvent?: AgentEventCallback
  ): Promise<AgentResponseWithState> {
    // Use the base class's runAgent method
    console.log("openaiAgent instructions", this.openaiAgent.instructions);
    return super.runAgent(messages, userId, state, persistState, onEvent);
  }
}
