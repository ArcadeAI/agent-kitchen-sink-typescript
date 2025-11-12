import {
  executeOrAuthorizeZodTool,
  toZod,
  type ZodTool,
} from "@arcadeai/arcadejs/lib";
import type { ToolDefinition } from "@arcadeai/arcadejs/resources/tools/tools";
import type { AuthorizationResponse } from "@arcadeai/arcadejs/resources.mjs";
import { tool } from "@openai/agents";
import arcadeClient from "./index";

export type AuthEvent = {
  providerId: string;
  status: string;
  url?: string;
  scopes: string[];
};

type GetToolsProps = {
  toolkits?: string[];
  tools?: string[];
  limit?: number;
  userId?: string;
};

// In general, retrieval tools are safe to run without approval.
// However, some tools are sensitive and should be approved by a human.
// This is a list of tools that should be approved by a human because they
// may result in a "side effect" like sending an email or message to the wro
const TOOLS_WITH_APPROVAL = [
  "Gmail_SendEmail",
  "Gmail_SendDraftEmail",
  "Gmail_TrashEmail",
  "Slack_SendDmToUser",
  "Slack_SendMessageToChannel",
  "Slack_SendMessage",
];

export async function getTools({
  toolkits = [],
  tools = [],
  limit = 30,
}: GetToolsProps): Promise<ToolDefinition[]> {
  if (toolkits.length === 0 && tools.length === 0) {
    throw new Error("At least one tool or toolkit must be provided");
  }

  // Todo(Mateo): Add pagination support
  const from_toolkits = await Promise.all(
    toolkits.map(async (tkitName) => {
      const definitions = await arcadeClient.tools.list({
        toolkit: tkitName,
        limit,
      });
      return definitions.items;
    })
  );

  const from_tools = await Promise.all(
    tools.map(async (toolName) => await arcadeClient.tools.get(toolName))
  );

  const all_tools = [...from_toolkits.flat(), ...from_tools];
  const unique_tools = Array.from(
    new Map(all_tools.map((t) => [t.qualified_name, t])).values()
  );

  return unique_tools;
}

// TODO: Figure out a more elegant way to do this for multiple profiders
export async function getToolsOpenAI({
  toolkits = [],
  tools = [],
  limit = 30,
  userId,
}: GetToolsProps): Promise<ReturnType<typeof tool>[]> {
  if (!userId) {
    throw new Error("userId is required");
  }
  const arcadeTools = await getTools({ toolkits, tools, limit });
  const toolWithApproval = (zodTool: ZodTool) => {
    // If the tool is in the list of tools that need approval, we need to
    // indicate that the tool needs approval. This will trigger an interrupt,
    // and we can approve or reject the tool call from the chatbot loop.
    return tool({
      ...zodTool,
      //needsApproval: true,
      needsApproval: async (_ctx: any, _input: any) =>
        TOOLS_WITH_APPROVAL.includes(zodTool.name),
    });
  };

  const zodTools = toZod({
    tools: arcadeTools,
    client: arcadeClient,
    userId,
    executeFactory: executeOrAuthorizeZodTool,
  });

  // Always use toolWithApproval - it checks TOOLS_WITH_APPROVAL internally
  return zodTools.map(toolWithApproval);
}

/**
 * @deprecated Use the event-based authorizeTools function instead
 */
export class AuthorizationPendingError extends Error {
  authResponses: AuthorizationResponse[];
  constructor(message: string, authResponses: AuthorizationResponse[]) {
    super(message);
    this.name = "AuthorizationPendingError";
    this.authResponses = authResponses;
  }
}

export async function authorizeTools(
  tools: ToolDefinition[],
  userId: string,
  onEvent?: (event: AuthEvent) => void | Promise<void>
): Promise<{ completed: boolean; authResponses: AuthorizationResponse[] }> {
  const providerToScopes = new Map<string, Set<string>>();
  for (const t of tools) {
    const providerId = t.requirements?.authorization?.provider_id;
    if (providerId) {
      let scopesSet = providerToScopes.get(providerId);
      if (!scopesSet) {
        scopesSet = new Set<string>();
        providerToScopes.set(providerId, scopesSet);
      }
      const newScopes = t.requirements?.authorization?.oauth2?.scopes ?? [];
      for (const scope of newScopes) {
        scopesSet.add(scope);
      }
    }
  }
  const authResponses: AuthorizationResponse[] = [];
  let allCompleted = true;

  for (const [providerId, scopesSet] of providerToScopes) {
    const authResponse = await arcadeClient.auth.start(userId, providerId, {
      scopes: Array.from(scopesSet),
    });
    authResponses.push(authResponse);

    if (authResponse.status !== "completed") {
      allCompleted = false;
      // Emit auth event if callback provided
      if (onEvent) {
        const event: AuthEvent = {
          providerId,
          status: authResponse.status,
          url: authResponse.url || undefined,
          scopes: Array.from(scopesSet),
        };
        await onEvent(event);
      }
    }
  }

  return {
    completed: allCompleted,
    authResponses,
  };
}
