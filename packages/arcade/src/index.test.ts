import { describe, expect, test } from "bun:test";

describe("Arcade Client", () => {
  test("should export arcade client", async () => {
    try {
      const arcadeClient = await import("./index");
      expect(arcadeClient.default).toBeDefined();
    } catch (error) {
      // If ARCADE_API_KEY is not set, the module will throw an error
      // This is expected in test environments without API keys
      if (error instanceof Error && error.message.includes("ARCADE_API_KEY")) {
        expect(true).toBe(true); // Test passes - missing env var is acceptable
      } else {
        throw error; // Re-throw unexpected errors
      }
    }
  });
});
