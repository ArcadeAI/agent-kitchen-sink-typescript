import "dotenv/config";
import { cors } from "@elysiajs/cors";
import arcadeClient from "@gmail-agents/arcade";
import { auth } from "@gmail-agents/auth";
import { Elysia } from "elysia";
import { agentsRoute } from "./agents-route";
import { HttpStatus } from "./constants";

const app = new Elysia()
  .use(
    cors({
      origin: process.env.CORS_ORIGIN || "",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  )
  .use(agentsRoute)
  .all("/api/auth/*", (context) => {
    const { request, status } = context;
    if (["POST", "GET"].includes(request.method)) {
      return auth.handler(request);
    }
    return status(HttpStatus.METHOD_NOT_ALLOWED);
  })
  .get("/api/arcade/verify", async (context) => {
    const { query, request, set } = context;
    const flowId = query.flow_id;

    // Validate required parameters
    if (!flowId) {
      set.status = HttpStatus.BAD_REQUEST;
      return { error: "Missing required parameter: flow_id" };
    }

    try {
      // Get the current user session
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session?.user) {
        set.status = HttpStatus.UNAUTHORIZED;
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
        // Return HTML page that closes the tab
        set.headers["Content-Type"] = "text/html";
        return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Successful</title>
</head>
<body>
  <div style="font-family: sans-serif; text-align: center; padding: 50px;">
    <h1>Authorization Successful!</h1>
    <p>You can close this tab and return to your chat.</p>
  </div>
  <script>
    // Close the tab/window
    window.close();
    // Fallback: if window.close() doesn't work (some browsers block it),
    // try to redirect after a short delay
    setTimeout(() => {
      if (!document.hidden) {
        window.location.href = "${
          process.env.CORS_ORIGIN || "http://localhost:3001"
        }/dashboard";
      }
    }, 1000);
  </script>
</body>
</html>`;
      }

      set.status = HttpStatus.BAD_REQUEST;
      set.headers["Content-Type"] = "text/html";
      return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Failed</title>
</head>
<body>
  <div style="font-family: sans-serif; text-align: center; padding: 50px;">
    <h1>Authorization Failed</h1>
    <p>Something went wrong. Please try again.</p>
    <p>Status: ${authResponse.status}</p>
  </div>
  <script>
    // Close the tab/window
    window.close();
    // Fallback: redirect after a short delay
    setTimeout(() => {
      if (!document.hidden) {
        window.location.href = "${
          process.env.CORS_ORIGIN || "http://localhost:3001"
        }/dashboard";
      }
    }, 2000);
  </script>
</body>
</html>`;
    } catch (error: unknown) {
      // Handle Arcade SDK errors that may have status and data properties
      let statusCode = HttpStatus.BAD_REQUEST;
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

      set.headers["Content-Type"] = "text/html";
      return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Error</title>
</head>
<body>
  <div style="font-family: sans-serif; text-align: center; padding: 50px;">
    <h1>Authorization Error</h1>
    <p>${errorMessage}</p>
  </div>
  <script>
    // Close the tab/window
    window.close();
    // Fallback: redirect after a short delay
    setTimeout(() => {
      if (!document.hidden) {
        window.location.href = "${
          process.env.CORS_ORIGIN || "http://localhost:3001"
        }/dashboard";
      }
    }, 2000);
  </script>
</body>
</html>`;
    }
  })
  .get("/", () => "OK");

export type App = typeof app;
export { app };
