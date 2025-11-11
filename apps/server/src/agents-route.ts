import type {
  AgentResponseWithState,
  Message,
  SessionState,
} from "@gmail-agents/agents";
import { Agent, type AgentConfig } from "@gmail-agents/agents";
import { InboxSummarizer } from "@gmail-agents/agents/inbox-agents/inbox-summarizer";
// Import event types using wildcard export
import type {
  AgentEvent,
  AgentEventCallback,
} from "@gmail-agents/agents/types";
import { auth } from "@gmail-agents/auth";
import prisma from "@gmail-agents/db";
import { Elysia, t } from "elysia";
import { HttpStatus } from "./constants";

// Type for agents that have the runAgent method with persistence callback
type AgentWithPersistence = {
  runAgent: (
    messages: Message[],
    userId: string,
    options?: {
      sessionState?: SessionState;
      persistState?: (
        state: SessionState,
        status?: SessionState["status"]
      ) => Promise<void>;
      onEvent?: AgentEventCallback;
    }
  ) => Promise<AgentResponseWithState>;
};

const AGENT_CONFIGS: Record<string, { systemInstructions: string }> = {
  "inbox-summarizer": {
    systemInstructions:
      "You are an inbox summarizer assistant. Help users summarize their emails efficiently.",
  },
  "inbox-prioritizer": {
    systemInstructions:
      "You are an inbox prioritization assistant. Help users prioritize their emails by identifying urgent and important messages. Focus on helping users focus on what matters most and manage their email workflow effectively.",
  },
  "meeting-prep": {
    systemInstructions:
      "You are a meeting preparation assistant. Help users prepare for meetings by analyzing relevant emails, extracting key information, and summarizing important points. Focus on providing context and action items related to upcoming meetings.",
  },
};

/**
 * Factory function to create a stateless agent instance
 */
function createAgent(agentId: string): AgentWithPersistence {
  const config = AGENT_CONFIGS[agentId];
  if (!config) {
    throw new Error(`Unknown agent ID: ${agentId}`);
  }

  const agentConfig: AgentConfig = {
    model: process.env.OPENAI_MODEL || "gpt-4o",
    systemInstructions: config.systemInstructions,
  };

  if (agentId === "inbox-summarizer") {
    return new InboxSummarizer(agentConfig) as AgentWithPersistence;
  }
  return new Agent(agentConfig) as AgentWithPersistence;
}

export const agentsRoute = new Elysia()
  .get("/api/agents/test", () => ({ message: "Agent route test works" }))
  // Create a new agent session
  .post(
    "/api/agents/sessions",
    async (context) => {
      const { body, request, set } = context;
      try {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user) {
          set.status = HttpStatus.UNAUTHORIZED;
          return { error: "User not authenticated" };
        }

        if (!body.agentId || typeof body.agentId !== "string") {
          set.status = HttpStatus.BAD_REQUEST;
          return { error: "Missing or invalid agentId" };
        }

        // Verify agent exists
        if (!AGENT_CONFIGS[body.agentId]) {
          set.status = HttpStatus.BAD_REQUEST;
          return { error: `Unknown agent ID: ${body.agentId}` };
        }

        // Create new session
        const agentSession = await prisma.agentSession.create({
          data: {
            userId: session.user.id,
            agentId: body.agentId,
            currentStep: 0,
            status: "active",
            stateData: {},
          },
        });

        // Add initial message if provided
        if (body.initialMessage) {
          await prisma.sessionItem.create({
            data: {
              sessionId: agentSession.id,
              type: "user_message",
              timestamp: BigInt(Date.now()),
              role: "user",
              content: body.initialMessage,
            },
          });
        }

        return {
          sessionId: agentSession.id,
          agentId: agentSession.agentId,
          status: agentSession.status,
        };
      } catch (error) {
        set.status = HttpStatus.INTERNAL_SERVER_ERROR;
        return {
          error:
            error instanceof Error ? error.message : "Failed to create session",
        };
      }
    },
    {
      body: t.Object({
        agentId: t.String(),
        initialMessage: t.Optional(t.String()),
      }),
    }
  )
  // Get session details
  .get(
    "/api/agents/sessions/:sessionId",
    async (context) => {
      const { params, request, set } = context;
      try {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user) {
          set.status = HttpStatus.UNAUTHORIZED;
          return { error: "User not authenticated" };
        }

        const agentSession = await prisma.agentSession.findFirst({
          where: {
            id: params.sessionId,
            userId: session.user.id,
          },
          include: {
            items: {
              orderBy: { timestamp: "asc" },
            },
          },
        });

        if (!agentSession) {
          set.status = HttpStatus.NOT_FOUND;
          return { error: "Session not found" };
        }

        return {
          sessionId: agentSession.id,
          agentId: agentSession.agentId,
          status: agentSession.status,
          currentStep: agentSession.currentStep,
          stateData: agentSession.stateData,
          items: agentSession.items.map(
            (item: {
              id: string;
              type: string;
              timestamp: bigint;
              role: string | null;
              content: string | null;
              step: string | null;
              stepIndex: number | null;
              data: unknown;
              state: unknown;
              error: string | null;
              createdAt: Date;
            }) => ({
              id: item.id,
              type: item.type,
              timestamp: Number(item.timestamp),
              role: item.role || undefined,
              content: item.content || undefined,
              step: item.step || undefined,
              stepIndex: item.stepIndex || undefined,
              data: item.data as Record<string, unknown> | undefined,
              state: item.state as SessionState | undefined,
              error: item.error || undefined,
              createdAt: item.createdAt,
            })
          ),
          createdAt: agentSession.createdAt,
          updatedAt: agentSession.updatedAt,
        };
      } catch (error) {
        set.status = HttpStatus.INTERNAL_SERVER_ERROR;
        return {
          error:
            error instanceof Error ? error.message : "Failed to fetch session",
        };
      }
    },
    {
      params: t.Object({
        sessionId: t.String(),
      }),
    }
  )
  // List user's sessions
  .get(
    "/api/agents/sessions",
    async (context) => {
      const { query, request, set } = context;
      try {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user) {
          set.status = HttpStatus.UNAUTHORIZED;
          return { error: "User not authenticated" };
        }

        const where: { userId: string; agentId?: string } = {
          userId: session.user.id,
        };

        if (query.agentId) {
          where.agentId = query.agentId as string;
        }

        const sessions = await prisma.agentSession.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          include: {
            items: {
              where: {
                type: "user_message",
              },
              take: 1,
              orderBy: { timestamp: "desc" },
            },
          },
        });

        return {
          sessions: sessions.map(
            (s: {
              id: string;
              agentId: string;
              status: string;
              currentStep: number;
              items: Array<{ content: string | null }>;
              updatedAt: Date;
            }) => ({
              sessionId: s.id,
              agentId: s.agentId,
              status: s.status,
              currentStep: s.currentStep,
              lastMessage: s.items[0]?.content || undefined,
              updatedAt: s.updatedAt,
            })
          ),
        };
      } catch (error) {
        set.status = HttpStatus.INTERNAL_SERVER_ERROR;
        return {
          error:
            error instanceof Error ? error.message : "Failed to list sessions",
        };
      }
    },
    {
      query: t.Object({
        agentId: t.Optional(t.String()),
      }),
    }
  )
  // Streaming chat endpoint - streams events as they happen
  .post(
    "/api/agents/sessions/:sessionId/chat/stream",
    async (context) => {
      const { params, body, query, request, set } = context;
      try {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user) {
          set.status = HttpStatus.UNAUTHORIZED;
          return { error: "User not authenticated" };
        }

        // Load session from database
        const agentSession = await prisma.agentSession.findFirst({
          where: {
            id: params.sessionId,
            userId: session.user.id,
          },
          include: {
            items: {
              orderBy: { timestamp: "asc" },
            },
          },
        });

        if (!agentSession) {
          set.status = HttpStatus.NOT_FOUND;
          return { error: "Session not found" };
        }

        // Check if this is a resumable stream request
        const lastEventTimestamp = query.lastEventTimestamp
          ? Number.parseInt(query.lastEventTimestamp as string, 10)
          : null;

        // If resuming, send all items since lastEventTimestamp (only event-type items)
        if (lastEventTimestamp) {
          const items = await prisma.sessionItem.findMany({
            where: {
              sessionId: agentSession.id,
              timestamp: {
                gt: BigInt(lastEventTimestamp),
              },
              // Only send event types, not message types
              type: {
                notIn: ["user_message", "assistant_message", "system_message"],
              },
            },
            orderBy: { timestamp: "asc" },
          });

          // If there are items to replay, return them as a stream
          if (items.length > 0) {
            const stream = new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                for (const item of items) {
                  const eventData: AgentEvent = {
                    type: item.type as AgentEvent["type"],
                    step: item.step || undefined,
                    stepIndex: item.stepIndex || undefined,
                    data: item.data as Record<string, unknown> | undefined,
                    state: item.state as unknown as SessionState | undefined,
                    error: item.error || undefined,
                    timestamp: Number(item.timestamp),
                  };
                  const json = `${JSON.stringify(eventData)}\n`;
                  controller.enqueue(encoder.encode(json));
                }
                controller.close();
              },
            });

            set.headers["Content-Type"] = "application/x-ndjson";
            set.headers["Cache-Control"] = "no-cache";
            set.headers.Connection = "keep-alive";
            set.headers["X-Accel-Buffering"] = "no";

            return new Response(stream, {
              headers: {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              },
            });
          }
        }

        // Track if we added a new message
        let newUserMessage: Message | null = null;

        if (!lastEventTimestamp && body.message) {
          // Create user message if this is a new message (not a resume)
          await prisma.sessionItem.create({
            data: {
              sessionId: agentSession.id,
              type: "user_message",
              timestamp: BigInt(Date.now()),
              role: "user",
              content: body.message,
            },
          });

          // Keep track of the new message to add to messages array
          newUserMessage = {
            role: "user",
            content: body.message,
          };
        }

        // Load session state from database
        const sessionState: SessionState = {
          currentStep: agentSession.currentStep,
          stepData: (agentSession.stateData as Record<string, unknown>) || {},
          status: agentSession.status as SessionState["status"],
        };

        // Convert database items (only message types) to agent format
        const messages = agentSession.items
          .filter((item) =>
            ["user_message", "assistant_message", "system_message"].includes(
              item.type
            )
          )
          .map(
            (item: {
              type: string;
              role: string | null;
              content: string | null;
            }) => ({
              role: item.role as "user" | "assistant" | "system",
              content: item.content || "",
            })
          );

        // Add the newly created user message to the messages array
        if (newUserMessage) {
          messages.push(newUserMessage);
        }

        // Create agent instance (stateless)
        const agent = createAgent(agentSession.agentId);

        // Create persistence callback for the agent
        const persistState = async (
          stateToSave: SessionState,
          statusToSave?: SessionState["status"]
        ) => {
          const stepData = stateToSave.stepData || {};
          const stateDataToSave = JSON.parse(JSON.stringify(stepData));
          const currentStep = stateToSave.currentStep ?? 0;
          const status = statusToSave || stateToSave.status || "active";
          await prisma.agentSession.update({
            where: { id: agentSession.id },
            data: {
              currentStep,
              status,
              stateData: stateDataToSave,
              updatedAt: new Date(),
            },
          });
        };

        // Set up streaming response
        set.headers["Content-Type"] = "application/x-ndjson";
        set.headers["Cache-Control"] = "no-cache";
        set.headers.Connection = "keep-alive";
        set.headers["X-Accel-Buffering"] = "no"; // Disable buffering for nginx

        // Create a readable stream
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();

            // Helper to persist and send an event
            const sendEvent = async (event: AgentEvent) => {
              try {
                // Persist event to database as a session item
                await prisma.sessionItem.create({
                  data: {
                    sessionId: agentSession.id,
                    type: event.type,
                    timestamp: BigInt(event.timestamp),
                    step: event.step || null,
                    stepIndex: event.stepIndex || null,
                    data: event.data
                      ? JSON.parse(JSON.stringify(event.data))
                      : null,
                    state: event.state
                      ? JSON.parse(JSON.stringify(event.state))
                      : null,
                    error: event.error || null,
                  },
                });

                // Stream event to client
                const json = `${JSON.stringify(event)}\n`;
                controller.enqueue(encoder.encode(json));

                // Check if this event requires external action and should close stream
                if (event.requiresExternalAction) {
                  // Stream will be closed by shouldCloseStream flag
                }
              } catch (_error) {
                // Silently handle event persistence errors
              }
            };

            // Send initial event to confirm stream is working
            await sendEvent({
              type: "state_updated",
              timestamp: Date.now(),
              data: { message: "Stream started" },
            });

            // Track if stream should be closed due to external action
            let shouldCloseStream = false;

            // Event callback for the agent
            const onEvent: AgentEventCallback = async (event: AgentEvent) => {
              await sendEvent(event);

              // If event requires external action, mark stream for closing
              if (event.requiresExternalAction) {
                shouldCloseStream = true;
              }
            };

            try {
              // Run agent with event callback
              const response = await agent.runAgent(messages, session.user.id, {
                sessionState,
                persistState,
                onEvent,
              });

              // Only save response and send complete event if stream wasn't closed early
              if (!shouldCloseStream) {
                const messageTimestamp = Date.now();

                // Save assistant response to database as a message item
                await prisma.sessionItem.create({
                  data: {
                    sessionId: agentSession.id,
                    type: "assistant_message",
                    timestamp: BigInt(messageTimestamp),
                    role: "assistant",
                    content: response.content,
                    data: response.metadata
                      ? JSON.parse(JSON.stringify(response.metadata))
                      : null,
                  },
                });

                // Send assistant message event to frontend for real-time display
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      type: "assistant_message",
                      timestamp: messageTimestamp,
                      role: "assistant",
                      content: response.content,
                    })}\n`
                  )
                );

                // Send final response event
                await sendEvent({
                  type: "complete",
                  timestamp: Date.now(),
                  data: {
                    status: response.status,
                    sessionState: response.sessionState,
                  },
                });
              }

              controller.close();
            } catch (error: unknown) {
              // Send error event
              await sendEvent({
                type: "error",
                timestamp: Date.now(),
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown error occurred",
              });

              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (error: unknown) {
        set.status = HttpStatus.INTERNAL_SERVER_ERROR;
        return {
          error:
            error instanceof Error ? error.message : "Failed to set up stream",
        };
      }
    },
    {
      params: t.Object({
        sessionId: t.String(),
      }),
      body: t.Object({
        message: t.Optional(t.String()),
      }),
      query: t.Object({
        lastEventTimestamp: t.Optional(t.String()),
      }),
    }
  )
  // Resume endpoint - for external events to wake up agents (OAuth callback, webhooks, etc.)
  .post(
    "/api/agents/sessions/:sessionId/resume",
    async (context) => {
      const { params, request, set } = context;
      try {
        const session = await auth.api.getSession({
          headers: request.headers,
        });

        if (!session?.user) {
          set.status = HttpStatus.UNAUTHORIZED;
          return { error: "User not authenticated" };
        }

        // Load session from database
        const agentSession = await prisma.agentSession.findFirst({
          where: {
            id: params.sessionId,
            userId: session.user.id,
          },
          include: {
            items: {
              orderBy: { timestamp: "asc" },
            },
          },
        });

        if (!agentSession) {
          set.status = HttpStatus.NOT_FOUND;
          return { error: "Session not found" };
        }

        // Load session state from database
        const sessionState: SessionState = {
          currentStep: agentSession.currentStep,
          stepData: (agentSession.stateData as Record<string, unknown>) || {},
          status: agentSession.status as SessionState["status"],
        };

        // Convert database items (only message types) to agent format
        const messages = agentSession.items
          .filter((item) =>
            ["user_message", "assistant_message", "system_message"].includes(
              item.type
            )
          )
          .map(
            (item: {
              type: string;
              role: string | null;
              content: string | null;
            }) => ({
              role: item.role as "user" | "assistant" | "system",
              content: item.content || "",
            })
          );

        // Create agent instance (stateless)
        const agent = createAgent(agentSession.agentId);

        // Create persistence callback for the agent
        const persistState = async (
          stateToSave: SessionState,
          statusToSave?: SessionState["status"]
        ) => {
          const stepData = stateToSave.stepData || {};
          const stateDataToSave = JSON.parse(JSON.stringify(stepData));
          const currentStep = stateToSave.currentStep ?? 0;
          const status = statusToSave || stateToSave.status || "active";
          await prisma.agentSession.update({
            where: { id: agentSession.id },
            data: {
              currentStep,
              status,
              stateData: stateDataToSave,
              updatedAt: new Date(),
            },
          });
        };

        // Set up streaming response
        set.headers["Content-Type"] = "application/x-ndjson";
        set.headers["Cache-Control"] = "no-cache";
        set.headers.Connection = "keep-alive";
        set.headers["X-Accel-Buffering"] = "no";

        // Create a readable stream
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();

            // Helper to persist and send an event
            const sendEvent = async (event: AgentEvent) => {
              try {
                // Persist event to database as a session item
                await prisma.sessionItem.create({
                  data: {
                    sessionId: agentSession.id,
                    type: event.type,
                    timestamp: BigInt(event.timestamp),
                    step: event.step || null,
                    stepIndex: event.stepIndex || null,
                    data: event.data
                      ? JSON.parse(JSON.stringify(event.data))
                      : null,
                    state: event.state
                      ? JSON.parse(JSON.stringify(event.state))
                      : null,
                    error: event.error || null,
                  },
                });

                // Stream event to client
                const json = `${JSON.stringify(event)}\n`;
                controller.enqueue(encoder.encode(json));
              } catch (_error) {
                // Silently handle event persistence errors
              }
            };

            // Send initial event to confirm stream is working
            await sendEvent({
              type: "state_updated",
              timestamp: Date.now(),
              data: { message: "Resuming agent session" },
            });

            // Track if stream should be closed due to external action
            let shouldCloseStream = false;

            // Event callback for the agent
            const onEvent: AgentEventCallback = async (event: AgentEvent) => {
              await sendEvent(event);

              // If event requires external action, mark stream for closing
              if (event.requiresExternalAction) {
                shouldCloseStream = true;
              }
            };

            try {
              // Run agent with event callback (no new user message, agent continues from state)
              const response = await agent.runAgent(messages, session.user.id, {
                sessionState,
                persistState,
                onEvent,
              });

              // Only save response and send complete event if stream wasn't closed early
              if (!shouldCloseStream) {
                // Save assistant response to database if there's content
                if (response.content) {
                  await prisma.sessionItem.create({
                    data: {
                      sessionId: agentSession.id,
                      type: "assistant_message",
                      timestamp: BigInt(Date.now()),
                      role: "assistant",
                      content: response.content,
                      data: response.metadata
                        ? JSON.parse(JSON.stringify(response.metadata))
                        : null,
                    },
                  });
                }

                // Send final response event
                await sendEvent({
                  type: "complete",
                  timestamp: Date.now(),
                  data: {
                    content: response.content,
                    metadata: response.metadata,
                    status: response.status,
                    sessionState: response.sessionState,
                  },
                });
              }

              controller.close();
            } catch (error: unknown) {
              // Send error event
              await sendEvent({
                type: "error",
                timestamp: Date.now(),
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown error occurred",
              });

              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (error: unknown) {
        set.status = HttpStatus.INTERNAL_SERVER_ERROR;
        return {
          error:
            error instanceof Error ? error.message : "Failed to resume session",
        };
      }
    },
    {
      params: t.Object({
        sessionId: t.String(),
      }),
    }
  );
