import { AlertCircle, Check, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type ToolApproval = {
  id: string;
  type: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  rawItem: {
    id: string;
    callId?: string;
    name?: string;
    arguments?: string;
    status?: string;
    type?: string;
    [key: string]: unknown;
  };
  agent?: {
    name: string;
  };
  [key: string]: unknown;
};

type OpenAIApprovalsProps = {
  approvals: ToolApproval[];
  sessionId: string;
  onApprovalResponse?: (approvalId: string, approved: boolean) => void;
  onStreamEvent?: (event: string) => void;
};

export function OpenAIApprovals({
  approvals,
  sessionId,
  onApprovalResponse,
  onStreamEvent,
}: OpenAIApprovalsProps) {
  const [processingApprovals, setProcessingApprovals] = useState<Set<string>>(
    new Set()
  );
  const [respondedApprovals, setRespondedApprovals] = useState<Set<string>>(
    new Set()
  );

  const handleApproval = async (approval: ToolApproval, approved: boolean) => {
    const approvalId = approval.rawItem.callId || approval.rawItem.id;
    setProcessingApprovals((prev) => new Set(prev).add(approvalId));

    try {
      const API_URL =
        import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
      const requestBody = {
        approvals: [
          {
            approvalId,
            approved,
          },
        ],
      };

      const response = await fetch(
        `${API_URL}/api/agents/sessions/${sessionId}/chat/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Process the stream response
      if (response.body && onStreamEvent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          let done = false;
          while (!done) {
            const { value, done: streamDone } = await reader.read();
            done = streamDone;

            if (value) {
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (line.trim()) {
                  onStreamEvent(line);
                }
              }
            }
          }

          // Process any remaining data in the buffer after stream closes
          if (buffer.trim()) {
            onStreamEvent(buffer);
          }
        } catch (_streamError) {
          // silently ignore error
        } finally {
          reader.releaseLock();
        }
      }

      setRespondedApprovals((prev) => new Set(prev).add(approvalId));

      if (onApprovalResponse) {
        onApprovalResponse(approvalId, approved);
      }
    } catch (_error) {
      // silently ignore error
    } finally {
      setProcessingApprovals((prev) => {
        const newSet = new Set(prev);
        newSet.delete(approvalId);
        return newSet;
      });
    }
  };

  const pendingApprovals = approvals.filter(
    (approval) =>
      !respondedApprovals.has(approval.rawItem.callId || approval.rawItem.id)
  );

  if (pendingApprovals.length === 0 && respondedApprovals.size === 0) {
    return null;
  }

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[80%] rounded-lg border-2 border-blue-500/50 bg-blue-50/50 px-4 py-4 dark:border-blue-500/30 dark:bg-blue-950/20">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex-shrink-0">
            <AlertCircle className="h-5 w-5 text-blue-600 dark:text-blue-500" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <p className="font-medium text-blue-900 text-sm dark:text-blue-100">
                Tool Approval Required
              </p>
              <p className="mt-1 text-blue-800 text-sm dark:text-blue-200">
                {pendingApprovals.length > 0
                  ? `The agent wants to use ${pendingApprovals.length} tool${
                      pendingApprovals.length > 1 ? "s" : ""
                    }. Please review and approve or reject:`
                  : "All tool requests have been processed."}
              </p>
            </div>
            {pendingApprovals.length > 0 && (
              <div className="space-y-3">
                {pendingApprovals.map((approval) => {
                  // Extract tool name from multiple possible locations
                  const toolName =
                    approval.tool_name ||
                    approval.rawItem.name ||
                    "Unknown Tool";

                  // Parse arguments if they're a string, otherwise use the object directly
                  let parsedArguments: Record<string, unknown> | null = null;
                  try {
                    if (approval.arguments) {
                      parsedArguments = approval.arguments;
                    } else if (approval.rawItem.arguments) {
                      parsedArguments =
                        typeof approval.rawItem.arguments === "string"
                          ? JSON.parse(approval.rawItem.arguments)
                          : approval.rawItem.arguments;
                    }
                  } catch (_e) {
                    parsedArguments = null;
                  }

                  return (
                    <div
                      className="rounded-md border border-blue-300 bg-white px-3 py-3 dark:border-blue-700 dark:bg-blue-950/40"
                      key={approval.rawItem.callId || approval.rawItem.id}
                    >
                      <div className="space-y-2">
                        <div>
                          <p className="font-semibold text-blue-900 text-sm dark:text-blue-100">
                            Tool: {toolName}
                          </p>
                          {parsedArguments &&
                            Object.keys(parsedArguments).length > 0 && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-blue-700 text-xs dark:text-blue-300">
                                  View parameters
                                </summary>
                                <pre className="mt-2 overflow-auto rounded bg-blue-100 p-2 text-xs dark:bg-blue-900/40">
                                  {JSON.stringify(parsedArguments, null, 2)}
                                </pre>
                              </details>
                            )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            className="flex-1 bg-green-600 hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-800"
                            disabled={processingApprovals.has(
                              approval.rawItem.callId || approval.rawItem.id
                            )}
                            onClick={() => handleApproval(approval, true)}
                            size="sm"
                          >
                            <Check className="mr-1 h-4 w-4" />
                            {processingApprovals.has(
                              approval.rawItem.callId || approval.rawItem.id
                            )
                              ? "Processing..."
                              : "Approve"}
                          </Button>
                          <Button
                            className="flex-1"
                            disabled={processingApprovals.has(
                              approval.rawItem.callId || approval.rawItem.id
                            )}
                            onClick={() => handleApproval(approval, false)}
                            size="sm"
                            variant="destructive"
                          >
                            <X className="mr-1 h-4 w-4" />
                            {processingApprovals.has(
                              approval.rawItem.callId || approval.rawItem.id
                            )
                              ? "Processing..."
                              : "Reject"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
