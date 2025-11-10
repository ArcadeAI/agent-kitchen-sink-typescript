import { describe, expect, it } from "bun:test";
// Import from index.ts to ensure dotenv is loaded
import { Agent } from "./index.js";
import type { Message } from "./types.js";

describe("Agent", () => {
  it("should create an agent instance", () => {
    const agent = new Agent({
      model: "gpt-4o",
      systemInstructions: "You are a test assistant.",
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("should throw error if OPENAI_API_KEY is not set", () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = undefined;

    expect(() => {
      new Agent();
    }).toThrow("OPENAI_API_KEY environment variable is required");

    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  // biome-ignore lint/suspicious/noSkippedTests: API integration test requires OpenAI key and network
  it.skip("should process messages and return response", async () => {
    // Skipped: requires OpenAI API key and network access
    const agent = new Agent({
      model: "gpt-4o",
      systemInstructions: "You are a helpful assistant.",
    });

    const messages: Message[] = [
      {
        role: "user",
        content: "Hello, how are you?",
      },
    ];

    const response = await agent.runAgent(messages, "test-user-id");

    expect(response).toHaveProperty("content");
    expect(typeof response.content).toBe("string");
    expect(response.content.length).toBeGreaterThan(0);
  });

  // biome-ignore lint/suspicious/noSkippedTests: API integration test requires OpenAI key and network
  it.skip("should handle conversation history", async () => {
    // Skipped: requires OpenAI API key and network access
    const agent = new Agent({
      model: "gpt-4o",
    });

    const messages: Message[] = [
      {
        role: "user",
        content: "My name is Alice.",
      },
      {
        role: "assistant",
        content: "Nice to meet you, Alice!",
      },
      {
        role: "user",
        content: "What's my name?",
      },
    ];

    const response = await agent.runAgent(messages, "test-user-id");

    expect(response.content.toLowerCase()).toContain("alice");
  });
});
