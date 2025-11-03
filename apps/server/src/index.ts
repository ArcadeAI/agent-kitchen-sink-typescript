import "dotenv/config";
import { cors } from "@elysiajs/cors";
import arcadeClient from "@gmail-agents/arcade";
import { auth } from "@gmail-agents/auth";
import { Elysia } from "elysia";

const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HTTP_STATUS_FOUND = 302;
const SERVER_PORT = 3000;

new Elysia()
  .use(
    cors({
      origin: process.env.CORS_ORIGIN || "",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  )
  .all("/api/auth/*", (context) => {
    const { request, status } = context;
    if (["POST", "GET"].includes(request.method)) {
      return auth.handler(request);
    }
    return status(HTTP_STATUS_METHOD_NOT_ALLOWED);
  })
  .get("/api/arcade/verify", async (context) => {
    const { query, request, set } = context;
    const flowId = query.flow_id;

    // Validate required parameters
    if (!flowId) {
      set.status = HTTP_STATUS_BAD_REQUEST;
      return { error: "Missing required parameter: flow_id" };
    }

    try {
      // Get the current user session
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session?.user) {
        set.status = HTTP_STATUS_UNAUTHORIZED;
        return { error: "User not authenticated" };
      }

      // Confirm the user's identity
      const result = await arcadeClient.auth.confirmUser({
        flow_id: flowId,
        user_id: session.user.id,
      });

      // Wait for completion to ensure the auth flow is fully processed
      const authResponse = await arcadeClient.auth.waitForCompletion(
        result.auth_id
      );

      if (authResponse.status === "completed") {
        // Redirect to dashboard after successful verification
        const frontendUrl = process.env.CORS_ORIGIN || "http://localhost:3001";
        set.status = HTTP_STATUS_FOUND;
        set.headers.Location = `${frontendUrl}/dashboard`;
        return;
      }

      set.status = HTTP_STATUS_BAD_REQUEST;
      return {
        error: "Something went wrong. Please try again.",
        status: authResponse.status,
      };
    } catch (error: unknown) {
      // Handle Arcade SDK errors that may have status and data properties
      let statusCode = HTTP_STATUS_BAD_REQUEST;
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
      ) {
        statusCode = error.status;
      }

      set.status = statusCode;

      let errorMessage = "Failed to verify the request";
      if (
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        typeof error.data === "object" &&
        error.data !== null &&
        "msg" in error.data &&
        typeof error.data.msg === "string"
      ) {
        errorMessage = error.data.msg;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      return {
        error: errorMessage,
      };
    }
  })
  .get("/", () => "OK")
  .listen(SERVER_PORT);
