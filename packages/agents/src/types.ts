/**
 * Message role types for conversation history
 */
export type MessageRole = "user" | "assistant" | "system";

/**
 * Authentication pattern for agents
 */
export enum AuthPattern {
  JIT = "JIT",
  PRE_AUTH = "pre-auth",
}

/**
 * A single message in the conversation history
 */
export interface Message {
  role: MessageRole;
  content: string;
}

/**
 * Configuration for an agent
 */
export interface AgentConfig {
  /**
   * The OpenAI model to use (e.g., "gpt-4o", "gpt-4-turbo")
   */
  model?: string;
  /**
   * System instructions for the agent
   */
  systemInstructions?: string;
  /**
   * Temperature for response generation (0-2)
   */
  temperature?: number;
  /**
   * Maximum tokens in the response
   */
  maxTokens?: number;
  /**
   * Description of what the agent does
   */
  agentDescription?: string;
  /**
   * List of integrations this agent uses
   */
  integrations?: string[];
  /**
   * Authentication pattern for the agent
   */
  authPattern?: AuthPattern;
  /**
   * Agentic score (0-1) indicating how autonomous the agent is
   */
  agentic?: number;
}

/**
 * Response from an agent
 */
export interface AgentResponse {
  /**
   * The text content of the agent's response
   */
  content: string;
  /**
   * Optional metadata about the response
   */
  metadata?: {
    model?: string;
    tokensUsed?: number;
    finishReason?: string;
  };
}

/**
 * Error response from an agent
 */
export interface AgentError {
  error: string;
  code?: string;
}

/**
 * Session status types
 */
export type SessionStatus =
  | "active"
  | "paused"
  | "completed"
  | "waiting_auth"
  | "waiting_input";

/**
 * Callback function for persisting session state
 * Called by the agent whenever state changes
 */
export type StatePersistenceCallback = (
  state: SessionState,
  status?: SessionStatus
) => Promise<void>;

/**
 * Types of events that can be emitted during agent execution
 */
export type AgentEventType =
  | "step_started"
  | "step_completed"
  | "step_progress"
  | "state_updated"
  | "error"
  | "complete"
  | "auth_required"
  | "waiting_user_input"
  | "tool_call_started"
  | "tool_call_completed"
  | "workflow_paused";

/**
 * Event emitted during agent execution
 */
export interface AgentEvent {
  /**
   * Type of event
   */
  type: AgentEventType;
  /**
   * Step name or identifier (if applicable)
   */
  step?: string;
  /**
   * Step index (if applicable)
   */
  stepIndex?: number;
  /**
   * Event data (step-specific information)
   */
  data?: Record<string, unknown>;
  /**
   * Current session state (if applicable)
   */
  state?: SessionState;
  /**
   * Error message (if type is "error")
   */
  error?: string;
  /**
   * Timestamp of the event
   */
  timestamp: number;
  /**
   * Flag for events that require external action (e.g., OAuth, user input)
   * When true, the stream should be closed after emitting this event
   */
  requiresExternalAction?: boolean;
  /**
   * Flag for whether agent can be resumed after this event
   */
  resumable?: boolean;
}

/**
 * Callback function for receiving agent events
 * Called by the agent whenever an event occurs
 */
export type AgentEventCallback = (event: AgentEvent) => void | Promise<void>;

/**
 * Session state that can be persisted and restored
 */
export interface SessionState {
  /**
   * Current step index in the workflow
   */
  currentStep: number;
  /**
   * Step-specific data (emails, summaries, tool states, etc.)
   */
  stepData: Record<string, unknown>;
  /**
   * Status of the session
   */
  status?: SessionStatus;
}

/**
 * Extended agent response that includes session state
 */
export interface AgentResponseWithState extends AgentResponse {
  /**
   * Updated session state after processing
   */
  sessionState: SessionState;
  /**
   * Status indicating if the agent is waiting for something
   */
  status?: SessionStatus;
}
