import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, ArrowLeft, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api-client";
import { OAuthAuthMessage, type AuthStatus } from "./oauth-auth-message";

// Unified item type - everything that happens in a session
interface SessionItem {
  id: string;
  type: string; // "user_message" | "assistant_message" | "system_message" | "step_started" | "step_completed" | "auth_required" | etc.
  timestamp: number;
  
  // Message fields (for *_message types)
  role?: "user" | "assistant" | "system";
  content?: string;
  
  // Event fields (for step/state/error types)
  step?: string;
  stepIndex?: number;
  data?: Record<string, unknown>;
  state?: unknown;
  error?: string;
}


interface ChatbotProps {
  agentId: string;
  agentName: string;
}

type SessionsResponse = Awaited<ReturnType<typeof api.api.agents.sessions.get>>;
type SessionListItem = NonNullable<NonNullable<SessionsResponse["data"]>["sessions"]>[number];

export function Chatbot({ agentId, agentName }: ChatbotProps) {
  const [items, setItems] = useState<SessionItem[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [lastEventTimestamp, setLastEventTimestamp] = useState<number | null>(null);
  const itemsEndRef = useRef<HTMLDivElement>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();

  const scrollToBottom = () => {
    itemsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [items]);

  // Fetch sessions for the agent
  const fetchSessions = async () => {
    setIsLoadingSessions(true);
    try {
      const response = await api.api.agents.sessions.get({
        query: { agentId },
      });
      if (response.data && !response.error && response.data.sessions) {
        setSessions(response.data.sessions);
      }
    } catch (error) {
      console.error("Failed to fetch sessions", error);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  // Load session items (unified messages and events)
  const loadSession = async (targetSessionId: string) => {
    try {
      const sessionResponse = await (api.api.agents.sessions as any)[targetSessionId].get();
      if (sessionResponse.data && !sessionResponse.error) {
        const session = sessionResponse.data;
        if (session.sessionId) {
          setSessionId(session.sessionId);
          setSessionStatus(session.status || "active");
          localStorage.setItem(`session_${agentId}`, session.sessionId);

          // Load all items from session (already sorted by timestamp)
          const sessionItems: SessionItem[] = (session.items || []).map((item: {
            id: string;
            type: string;
            timestamp: number;
            role?: string;
            content?: string;
            step?: string;
            stepIndex?: number;
            data?: unknown;
            state?: unknown;
            error?: string;
          }) => ({
            id: item.id,
            type: item.type,
            timestamp: item.timestamp,
            role: item.role as "user" | "assistant" | "system" | undefined,
            content: item.content,
            step: item.step,
            stepIndex: item.stepIndex,
            data: item.data as Record<string, unknown> | undefined,
            state: item.state,
            error: item.error,
          }));
          setItems(sessionItems);

          // Set last event timestamp for resumable streams (only non-message items)
          const eventItems = sessionItems.filter(item => 
            !["user_message", "assistant_message", "system_message"].includes(item.type)
          );
          if (eventItems.length > 0) {
            const lastTimestamp = Math.max(...eventItems.map(e => e.timestamp));
            setLastEventTimestamp(lastTimestamp);
          } else {
            setLastEventTimestamp(null);
          }

          // If session is active and there are events, try to resume stream
          if (session.status === "active" && eventItems.length > 0) {
            const lastCompleteEvent = eventItems
              .filter(e => e.type === "complete" || e.type === "error")
              .pop();
            // If there's no complete event, the agent might still be working
            if (!lastCompleteEvent) {
              const lastTimestamp = Math.max(...eventItems.map(e => e.timestamp));
              resumeStream(targetSessionId, lastTimestamp);
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to load session", error);
    }
  };

  // Create new session
  const createNewSession = async () => {
    try {
      const createResponse = await api.api.agents.sessions.post({
        agentId,
      });

      if (createResponse.data && !createResponse.error && createResponse.data.sessionId) {
        const newSessionId = createResponse.data.sessionId;
        setSessionId(newSessionId);
        localStorage.setItem(`session_${agentId}`, newSessionId);
        setItems([]);
        // Refresh sessions list
        await fetchSessions();
        // Load the new session
        await loadSession(newSessionId);
      }
    } catch (error) {
      console.error("Failed to create new session", error);
    }
  };

  // Fetch sessions on mount and when agentId changes
  useEffect(() => {
    fetchSessions();
  }, [agentId]);

  // Initialize session on mount
  useEffect(() => {
    const initializeSession = async () => {
      try {
        // Check if there's a sessionId in localStorage for this agent
        const storedSessionId = localStorage.getItem(`session_${agentId}`);

        if (storedSessionId) {
          // Try to load existing session
          try {
            await loadSession(storedSessionId);
            return;
          } catch (error) {
            console.error("Failed to load session, creating new one", error);
            // Session doesn't exist, create a new one
          }
        }

        // Create new session if no stored session
        await createNewSession();
      } catch (error) {
        console.error("Failed to initialize session", error);
      }
    };

    initializeSession();
  }, [agentId]);

  // Resume stream from last event timestamp
  const resumeStream = async (targetSessionId: string, timestamp: number) => {
    if (!timestamp) return;

    const API_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
    const controller = new AbortController();
    streamControllerRef.current = controller;

    try {
      const response = await fetch(
        `${API_URL}/api/agents/sessions/${targetSessionId}/chat/stream?lastEventTimestamp=${timestamp}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({}),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      await processStream(response.body, controller);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Error resuming stream:", error);
      }
    }
  };

  // Process stream events - converts incoming events to items
  const processStream = async (body: ReadableStream<Uint8Array>, controller: AbortController) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("Stream ended");
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            console.log("Received event:", event.type, event);

            // Update last event timestamp
            if (event.timestamp) {
              setLastEventTimestamp(event.timestamp);
            }

            // Update session status from state if available
            if (event.state && typeof event.state === "object" && "status" in event.state) {
              setSessionStatus(event.state.status as string);
            }

            // Convert event to SessionItem and add to items
            const sessionItem: SessionItem = {
              id: crypto.randomUUID(),
              type: event.type,
              timestamp: event.timestamp || Date.now(),
              role: event.role as "user" | "assistant" | "system" | undefined,
              content: event.content,
              step: event.step,
              stepIndex: event.stepIndex,
              data: event.data,
              state: event.state,
              error: event.error,
            };

            // Add item to state (avoid duplicates by timestamp and type)
            setItems((prev) => {
              if (prev.some(item => item.timestamp === sessionItem.timestamp && item.type === sessionItem.type)) {
                return prev;
              }
              return [...prev, sessionItem];
            });

            // Handle specific event types
            switch (event.type) {
              case "state_updated":
                // Handle state updates (including initial stream started event)
                if (event.data && (event.data as { message?: string }).message === "Stream started") {
                  setIsLoading(false); // Hide thinking indicator when stream starts
                }
                break;

              case "step_started":
                setIsLoading(false); // Hide thinking indicator when steps start
                break;

              case "auth_required":
                console.log("🔐 Auth required event received!");
                console.log("🔐 Event data:", event.data);
                setIsLoading(false); // Stop loading indicator

                // Update session status from event.state
                if (event.state && typeof event.state === "object" && "status" in event.state) {
                  const status = (event.state as { status: string }).status;
                  console.log("🔐 Setting session status to:", status);
                  setSessionStatus(status);
                }
                break;

              case "complete":
                setIsLoading(false); // Ensure loading is off
                // Update session status only (assistant message is already saved in DB)
                if (event.data) {
                  const data = event.data as {
                    status?: string;
                  };

                  console.log("🔍 Complete event data:", event.data);

                  // Update session status
                  if (data.status) {
                    setSessionStatus(data.status);
                  }
                }
                break;

              case "error":
                setIsLoading(false);
                setSessionStatus("active"); // Reset status on error
                break;
            }
          } catch (parseError) {
            console.error("Failed to parse event:", parseError, line);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Error processing stream:", error);
      }
    } finally {
      reader.releaseLock();
    }
  };

  const sendMessage = async () => {
    // Block sending if agent is working (status is not "active" or "waiting_auth")
    const canSend = sessionStatus === "active" || sessionStatus === "waiting_auth";
    if (!input.trim() || isLoading || !sessionId || !canSend) return;

    const userItem: SessionItem = {
      id: crypto.randomUUID(),
      type: "user_message",
      timestamp: Date.now(),
      role: "user",
      content: input.trim(),
    };

    setItems((prev) => [...prev, userItem]);
    const messageText = input.trim();
    setInput("");
    setIsLoading(true);

    try {
      if (!sessionId) return;

      // Cancel any existing stream
      if (streamControllerRef.current) {
        streamControllerRef.current.abort();
      }

      // Use streaming endpoint
      const API_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
      const controller = new AbortController();
      streamControllerRef.current = controller;

      // Update status to indicate agent is working
      setSessionStatus("active");

      const response = await fetch(
        `${API_URL}/api/agents/sessions/${sessionId}/chat/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ message: messageText }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      await processStream(response.body, controller);

      // Refresh sessions list to update last message
      await fetchSessions();
    } catch (error) {
      const errorItem: SessionItem = {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: Date.now(),
        error:
          error instanceof Error
            ? error.message
            : "An error occurred. Please try again.",
      };
      setItems((prev) => [...prev, errorItem]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleBackToGallery = () => {
    navigate({
      to: "/dashboard",
      search: {},
    });
  };

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = now.getTime() - dateObj.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return dateObj.toLocaleDateString();
  };

  return (
    <Card className="flex h-[600px] flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBackToGallery}
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <CardTitle>Go to Agent Gallery</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 gap-4 overflow-hidden p-0">
        {/* Sidebar */}
        <div className="flex w-64 flex-col border-r bg-muted/30">
          <div className="border-b p-4">
            <Button
              onClick={createNewSession}
              className="w-full"
              size="sm"
            >
              <Plus className="mr-2 h-4 w-4" />
              New Session
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {isLoadingSessions ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Loading sessions...
              </div>
            ) : sessions.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No sessions yet
              </div>
            ) : (
              <div className="space-y-1">
                {sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    onClick={() => loadSession(session.sessionId)}
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                      session.sessionId === sessionId
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                  >
                    <div className="truncate font-medium">
                      {session.lastMessage || "New session"}
                    </div>
                    <div
                      className={cn(
                        "truncate text-xs",
                        session.sessionId === sessionId
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground"
                      )}
                    >
                      {formatDate(session.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* Chat area */}
        <div className="flex flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {items.length === 0 && (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p>Start a conversation with the agent...</p>
            </div>
          )}
          {items.map((item) => {
            // Render messages
            if (item.type === "user_message" || item.type === "assistant_message" || item.type === "system_message") {
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex w-full",
                    item.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-4 py-2",
                      item.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {item.content}
                    </p>
                  </div>
                </div>
              );
            }
            
            // Render auth_required with all configs from data
            if (item.type === "auth_required" && item.data) {
              const authData = item.data as { url?: string; providerId?: string; status?: string };
              return (
                <OAuthAuthMessage 
                  key={item.id} 
                  configs={[{
                    url: authData.url,
                    providerId: authData.providerId,
                    status: authData.status as AuthStatus | undefined,
                  }]} 
                />
              );
            }
            
            // Render step events
            if (item.type === "step_started" || item.type === "step_completed") {
              return (
                <div
                  key={item.id}
                  className="flex w-full justify-start"
                >
                  <div className="max-w-[80%] rounded-lg border border-muted-foreground/20 bg-muted/50 px-4 py-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {item.type === "step_started" ? "Starting" : "Completed"}: {item.step || "step"}
                    </p>
                    {item.data && Object.keys(item.data).length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          View details
                        </summary>
                        <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                          {JSON.stringify(item.data, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              );
            }
            
            // Render errors
            if (item.type === "error") {
              return (
                <div key={item.id} className="flex w-full justify-start">
                  <div className="max-w-[80%] rounded-lg bg-destructive/10 px-4 py-2">
                    <p className="text-sm text-destructive">Error: {item.error}</p>
                  </div>
                </div>
              );
            }
            
            // Skip rendering other event types (state_updated, complete, etc.)
            return null;
          })}
          {isLoading && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg bg-muted px-4 py-2">
                <p className="text-sm text-muted-foreground">Thinking...</p>
              </div>
            </div>
          )}
          <div ref={itemsEndRef} />
        </div>
        <div className="flex gap-2 border-t px-6 py-4">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={
              !sessionId
                ? "Initializing session..."
                : sessionStatus !== "active" && sessionStatus !== "waiting_auth"
                  ? "Agent is working, please wait..."
                  : "Type your message..."
            }
            disabled={isLoading || !sessionId || (sessionStatus !== "active" && sessionStatus !== "waiting_auth")}
            className="flex-1"
          />
          <Button
            onClick={sendMessage}
            disabled={isLoading || !input.trim() || !sessionId || (sessionStatus !== "active" && sessionStatus !== "waiting_auth")}
            size="icon"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        </div>
      </CardContent>
    </Card>
  );
}

