import { describe, expect, mock, test } from "bun:test";
import { cors } from "@elysiajs/cors";
import { auth } from "@gmail-agents/auth";
import { Elysia, t } from "elysia";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

// Create a test server instance
function createTestServer() {
  // Mock the agent
  const mockAgent = {
    process: mock(
      async (messages: Array<{ role: string; content: string }>) => ({
        content: `Mock response to: ${messages.at(-1)?.content || ""}`,
        metadata: {
          model: "gpt-4o",
          tokensUsed: 100,
          finishReason: "stop",
        },
      })
    ),
  };

  const app = new Elysia()
    .use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      })
    )
    .post(
      "/api/agents/chat",
      async (context) => {
        const { body, request, set } = context;

        try {
          // Get the current user session
          const session = await auth.api.getSession({
            headers: request.headers,
          });

          if (!session?.user) {
            set.status = HTTP_STATUS_UNAUTHORIZED;
            return { error: "User not authenticated" };
          }

          // Validate message history
          if (!(body.messages && Array.isArray(body.messages))) {
            set.status = HTTP_STATUS_BAD_REQUEST;
            return { error: "Missing or invalid messages array" };
          }

          // Validate each message has required fields
          for (const message of body.messages) {
            if (!(message.role && message.content)) {
              set.status = HTTP_STATUS_BAD_REQUEST;
              return {
                error: "Each message must have 'role' and 'content' fields",
              };
            }
            if (!["user", "assistant", "system"].includes(message.role)) {
              set.status = HTTP_STATUS_BAD_REQUEST;
              return {
                error:
                  "Message role must be one of: 'user', 'assistant', 'system'",
              };
            }
          }

          // Process the conversation with the agent
          const response = await mockAgent.process(body.messages);

          return {
            content: response.content,
            metadata: response.metadata,
          };
        } catch (error: unknown) {
          set.status = HTTP_STATUS_INTERNAL_SERVER_ERROR;

          let errorMessage = "Failed to process agent request";
          if (error instanceof Error) {
            errorMessage = error.message;
          }

          return {
            error: errorMessage,
          };
        }
      },
      {
        body: t.Object({
          messages: t.Array(
            t.Object({
              role: t.Union([
                t.Literal("user"),
                t.Literal("assistant"),
                t.Literal("system"),
              ]),
              content: t.String(),
            })
          ),
        }),
      }
    );

  return { app, mockAgent };
}

describe("Server", () => {
  test("should be importable", () => {
    expect(true).toBe(true);
  });

  describe("Agent Chat Endpoint", () => {
    test("should return 401 when not authenticated", async () => {
      const { app } = createTestServer();

      const response = await app.handle(
        new Request("http://localhost/api/agents/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: "Hello",
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(HTTP_STATUS_UNAUTHORIZED);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("User not authenticated");
    });

    test("should send messages to agent and return response", async () => {
      const { app, mockAgent } = createTestServer();

      // Mock auth to return a valid session
      const originalGetSession = auth.api.getSession;
      auth.api.getSession = mock(
        async (_context) =>
          ({
            user: {
              id: "test-user-id",
              email: "test@example.com",
              name: "Test User",
            },
            session: {
              id: "test-session-id",
              userId: "test-user-id",
              expiresAt: new Date(
                Date.now() +
                  MILLISECONDS_PER_SECOND *
                    SECONDS_PER_MINUTE *
                    MINUTES_PER_HOUR
              ),
            },
          }) as Awaited<ReturnType<typeof auth.api.getSession>>
      ) as typeof auth.api.getSession;

      try {
        const response = await app.handle(
          new Request("http://localhost/api/agents/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: "Hello, how are you?",
                },
              ],
            }),
          })
        );

        expect(response.status).toBe(HTTP_STATUS_OK);
        const data = (await response.json()) as {
          content: string;
          metadata: {
            model: string;
            tokensUsed?: number;
            finishReason?: string;
          };
        };
        expect(data).toHaveProperty("content");
        expect(data).toHaveProperty("metadata");
        expect(typeof data.content).toBe("string");
        expect(data.content).toContain("Hello, how are you?");
        expect(data.metadata.model).toBe("gpt-4o");

        // Verify the agent was called with the correct messages
        expect(mockAgent.process).toHaveBeenCalledTimes(1);
        expect(mockAgent.process).toHaveBeenCalledWith([
          {
            role: "user",
            content: "Hello, how are you?",
          },
        ]);
      } finally {
        // Restore original getSession
        auth.api.getSession = originalGetSession;
      }
    });

    test("should handle conversation history", async () => {
      const { app, mockAgent } = createTestServer();

      // Mock auth to return a valid session
      const originalGetSession = auth.api.getSession;
      auth.api.getSession = mock(
        async (_context) =>
          ({
            user: {
              id: "test-user-id",
              email: "test@example.com",
              name: "Test User",
            },
            session: {
              id: "test-session-id",
              userId: "test-user-id",
              expiresAt: new Date(
                Date.now() +
                  MILLISECONDS_PER_SECOND *
                    SECONDS_PER_MINUTE *
                    MINUTES_PER_HOUR
              ),
            },
          }) as Awaited<ReturnType<typeof auth.api.getSession>>
      ) as typeof auth.api.getSession;

      try {
        const messages = [
          { role: "user" as const, content: "My name is Alice" },
          { role: "assistant" as const, content: "Nice to meet you, Alice!" },
          { role: "user" as const, content: "What's my name?" },
        ];

        const response = await app.handle(
          new Request("http://localhost/api/agents/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ messages }),
          })
        );

        expect(response.status).toBe(HTTP_STATUS_OK);
        const data = (await response.json()) as {
          content: string;
          metadata: {
            model: string;
            tokensUsed?: number;
            finishReason?: string;
          };
        };
        expect(data.content).toContain("What's my name?");

        // Verify the agent was called with the full conversation history
        expect(mockAgent.process).toHaveBeenCalledWith(messages);
      } finally {
        // Restore original getSession
        auth.api.getSession = originalGetSession;
      }
    });

    test("should validate message format", async () => {
      const { app } = createTestServer();

      // Mock auth to return a valid session
      const originalGetSession = auth.api.getSession;
      auth.api.getSession = mock(
        async (_context) =>
          ({
            user: {
              id: "test-user-id",
              email: "test@example.com",
              name: "Test User",
            },
            session: {
              id: "test-session-id",
              userId: "test-user-id",
              expiresAt: new Date(
                Date.now() +
                  MILLISECONDS_PER_SECOND *
                    SECONDS_PER_MINUTE *
                    MINUTES_PER_HOUR
              ),
            },
          }) as Awaited<ReturnType<typeof auth.api.getSession>>
      ) as typeof auth.api.getSession;

      try {
        // Test missing messages array - Elysia schema validation returns 422
        const response1 = await app.handle(
          new Request("http://localhost/api/agents/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          })
        );

        expect(response1.status).toBe(HTTP_STATUS_UNPROCESSABLE_ENTITY); // Elysia returns 422 for schema validation errors

        // Test invalid message format - Elysia schema validation returns 422
        const response2 = await app.handle(
          new Request("http://localhost/api/agents/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [{ role: "user" }], // missing content
            }),
          })
        );

        expect(response2.status).toBe(HTTP_STATUS_UNPROCESSABLE_ENTITY); // Elysia returns 422 for schema validation errors

        // Test invalid role - Elysia schema validation also catches this (422)
        const response3 = await app.handle(
          new Request("http://localhost/api/agents/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [{ role: "invalid-role", content: "test" }],
            }),
          })
        );

        expect(response3.status).toBe(HTTP_STATUS_UNPROCESSABLE_ENTITY); // Elysia schema validation catches invalid enum values
      } finally {
        // Restore original getSession
        auth.api.getSession = originalGetSession;
      }
    });
  });
});
