import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { type AuthStatus, OAuthAuthMessage } from "./oauth-auth-message";

// Unified item type - everything that happens in a session
type SessionItem = {
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
};

type ChatbotProps = {
  agentId: string;
  agentName: string;
};

type SessionsResponse = Awaited<ReturnType<typeof api.api.agents.sessions.get>>;
type SessionListItem = NonNullable<
  NonNullable<SessionsResponse["data"]>["sessions"]
>[number];

export function Chatbot({ agentId, agentName }: ChatbotProps) {
  const [items, setItems] = useState<SessionItem[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [_lastEventTimestamp, setLastEventTimestamp] = useState<number | null>(
    null
  );
  const itemsEndRef = useRef<HTMLDivElement>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();

  const scrollToBottom = useCallback(() => {
    itemsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Fetch sessions for the agent
  const fetchSessions = useCallback(async () => {
    setIsLoadingSessions(true);
    try {
      const response = await api.api.agents.sessions.get({
        query: { agentId },
      });
      if (response.data && !response.error && response.data.sessions) {
        setSessions(response.data.sessions);
      }
    } catch (_error) {
      // Silently handle fetch errors
    } finally {
      setIsLoadingSessions(false);
    }
  }, [agentId]);

  // Helper: Convert API session items to SessionItem type
  const convertSessionItems = (rawItems: unknown[]): SessionItem[] =>
    (
      rawItems as Array<{
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
      }>
    ).map((item) => ({
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

  // Helper: Filter out message-type items to get events only
  const filterEventItems = (sessionItems: SessionItem[]): SessionItem[] =>
    sessionItems.filter(
      (item) =>
        !["user_message", "assistant_message", "system_message"].includes(
          item.type
        )
    );

  // Helper: Update last event timestamp from items
  const updateLastEventTimestamp = (eventItems: SessionItem[]) => {
    if (eventItems.length > 0) {
      const lastTimestamp = Math.max(...eventItems.map((e) => e.timestamp));
      setLastEventTimestamp(lastTimestamp);
    } else {
      setLastEventTimestamp(null);
    }
  };

  // Helper: Check if stream should be resumed
  const shouldResumeStream = (
    status: string | undefined,
    eventItems: SessionItem[]
  ): boolean => {
    if (status !== "active" || eventItems.length === 0) {
      return false;
    }
    const lastCompleteEvent = eventItems
      .filter((e) => e.type === "complete" || e.type === "error")
      .pop();
    return !lastCompleteEvent;
  };

  // Load session items (unified messages and events)
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      try {
        const sessionResponse = await (
          api.api.agents.sessions as unknown as Record<
            string,
            {
              get: () => Promise<{
                data?: {
                  sessionId?: string;
                  status?: string;
                  items?: unknown[];
                };
                error?: unknown;
              }>;
            }
          >
        )[targetSessionId].get();

        if (
          !sessionResponse.data ||
          sessionResponse.error ||
          !sessionResponse.data.sessionId
        ) {
          return;
        }

        const session = sessionResponse.data;
        const sessionIdValue = session.sessionId;
        if (!sessionIdValue) {
          return;
        }
        setSessionId(sessionIdValue);
        setSessionStatus(session.status || "active");
        localStorage.setItem(`session_${agentId}`, sessionIdValue);

        const sessionItems = convertSessionItems(session.items || []);
        setItems(sessionItems);

        const eventItems = filterEventItems(sessionItems);
        updateLastEventTimestamp(eventItems);

        if (shouldResumeStream(session.status, eventItems)) {
          const lastTimestamp = Math.max(...eventItems.map((e) => e.timestamp));
          resumeStream(targetSessionId, lastTimestamp);
        }
      } catch (_error) {
        // Silently handle session loading errors
      }
    },
    [agentId]
  );

  // Create new session
  const createNewSession = useCallback(async () => {
    try {
      const createResponse = await api.api.agents.sessions.post({
        agentId,
      });

      if (
        createResponse.data &&
        !createResponse.error &&
        createResponse.data.sessionId
      ) {
        const newSessionId = createResponse.data.sessionId;
        setSessionId(newSessionId);
        localStorage.setItem(`session_${agentId}`, newSessionId);
        setItems([]);
        // Refresh sessions list
        await fetchSessions();
        // Load the new session
        await loadSession(newSessionId);
      }
    } catch (_error) {
      // Silently handle session creation errors
    }
  }, [agentId, fetchSessions, loadSession]);

  // Fetch sessions on mount and when agentId changes
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

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
          } catch (_error) {
            // Session doesn't exist, create a new one
          }
        }

        // Create new session if no stored session
        await createNewSession();
      } catch (_error) {
        // Silently handle initialization errors
      }
    };

    initializeSession();
  }, [agentId, createNewSession, loadSession]);

  // Resume stream from last event timestamp
  const resumeStream = async (targetSessionId: string, timestamp: number) => {
    if (!timestamp) {
      return;
    }

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
        // Log non-abort errors (silently)
      }
    }
  };

  // Helper: Update state from event
  const updateStateFromEvent = (event: {
    timestamp?: number;
    state?: unknown;
  }) => {
    if (event.timestamp) {
      setLastEventTimestamp(event.timestamp);
    }
    if (
      event.state &&
      typeof event.state === "object" &&
      "status" in event.state
    ) {
      setSessionStatus((event.state as { status: string }).status);
    }
  };

  // Helper: Convert event to SessionItem
  const eventToSessionItem = (event: {
    type: string;
    timestamp?: number;
    role?: string;
    content?: string;
    step?: string;
    stepIndex?: number;
    data?: Record<string, unknown>;
    state?: unknown;
    error?: string;
  }): SessionItem => ({
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
  });

  // Helper: Add session item (avoiding duplicates)
  const addSessionItem = (sessionItem: SessionItem) => {
    setItems((prev) => {
      if (
        prev.some(
          (item) =>
            item.timestamp === sessionItem.timestamp &&
            item.type === sessionItem.type
        )
      ) {
        return prev;
      }
      return [...prev, sessionItem];
    });
  };

  // Helper: Handle state_updated event
  const handleStateUpdated = (data?: Record<string, unknown>) => {
    if (data && (data as { message?: string }).message === "Stream started") {
      setIsLoading(false);
    }
  };

  // Helper: Handle auth_required event
  const handleAuthRequired = (state?: unknown) => {
    setIsLoading(false);
    if (state && typeof state === "object" && "status" in state) {
      setSessionStatus((state as { status: string }).status);
    }
  };

  // Helper: Handle complete event
  const handleComplete = (data?: Record<string, unknown>) => {
    setIsLoading(false);
    if (data) {
      const typedData = data as { status?: string };
      if (typedData.status) {
        setSessionStatus(typedData.status);
      }
    }
  };

  // Helper: Handle error event
  const handleError = () => {
    setIsLoading(false);
    setSessionStatus("active");
  };

  // Helper: Handle different event types
  const handleEventType = (event: {
    type: string;
    data?: Record<string, unknown>;
    state?: unknown;
  }) => {
    switch (event.type) {
      case "state_updated":
        handleStateUpdated(event.data);
        break;
      case "step_started":
        setIsLoading(false);
        break;
      case "auth_required":
        handleAuthRequired(event.state);
        break;
      case "complete":
        handleComplete(event.data);
        break;
      case "error":
        handleError();
        break;
      default:
        // Ignore unknown event types
        break;
    }
  };

  // Helper: Process a single line from stream
  const processStreamLine = (line: string) => {
    if (!line.trim()) {
      return;
    }

    try {
      const event = JSON.parse(line);
      updateStateFromEvent(event);
      const sessionItem = eventToSessionItem(event);
      addSessionItem(sessionItem);
      handleEventType(event);
    } catch (_parseError) {
      // Silently handle JSON parse errors
    }
  };

  // Helper: Read and process stream chunks
  const readStreamChunk = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    buffer: string
  ): Promise<{ buffer: string; done: boolean }> => {
    const { done, value } = await reader.read();
    if (done) {
      return { buffer, done: true };
    }

    const newBuffer = buffer + decoder.decode(value, { stream: true });
    const lines = newBuffer.split("\n");
    const remainingBuffer = lines.pop() || "";

    for (const line of lines) {
      processStreamLine(line);
    }

    return { buffer: remainingBuffer, done: false };
  };

  // Process stream events - converts incoming events to items
  const processStream = async (
    body: ReadableStream<Uint8Array>,
    _controller: AbortController
  ) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      let done = false;
      while (!done) {
        const result = await readStreamChunk(reader, decoder, buffer);
        buffer = result.buffer;
        done = result.done;
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        // Log non-abort errors (silently)
      }
    } finally {
      reader.releaseLock();
    }
  };

  // Helper: Check if message can be sent
  const canSendMessage = (): boolean => {
    const canSend =
      sessionStatus === "active" || sessionStatus === "waiting_auth";
    return !(!input.trim() || isLoading || !sessionId || !canSend);
  };

  // Helper: Create user message item
  const createUserMessageItem = (content: string): SessionItem => ({
    id: crypto.randomUUID(),
    type: "user_message",
    timestamp: Date.now(),
    role: "user",
    content,
  });

  // Helper: Set up new stream controller
  const setupStreamController = (): AbortController => {
    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
    }
    const controller = new AbortController();
    streamControllerRef.current = controller;
    return controller;
  };

  // Helper: Fetch stream from API
  const fetchChatStream = async (
    targetSessionId: string,
    message: string,
    signal: AbortSignal
  ): Promise<Response> => {
    const API_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
    const response = await fetch(
      `${API_URL}/api/agents/sessions/${targetSessionId}/chat/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ message }),
        signal,
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

    return response;
  };

  // Helper: Add error item to session
  const addErrorItem = (error: unknown) => {
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
  };

  const sendMessage = async () => {
    if (!(canSendMessage() && sessionId)) {
      return;
    }

    const messageText = input.trim();
    const userItem = createUserMessageItem(messageText);
    setItems((prev) => [...prev, userItem]);
    setInput("");
    setIsLoading(true);
    setSessionStatus("active");

    try {
      const controller = setupStreamController();
      const response = await fetchChatStream(
        sessionId,
        messageText,
        controller.signal
      );
      if (response.body) {
        await processStream(response.body, controller);
      }
      await fetchSessions();
    } catch (error) {
      addErrorItem(error);
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

  // Time constants for date formatting
  const MS_PER_MINUTE = 60_000;
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY = 86_400_000;
  const DAYS_PER_WEEK = 7;

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = now.getTime() - dateObj.getTime();
    const diffMins = Math.floor(diffMs / MS_PER_MINUTE);
    const diffHours = Math.floor(diffMs / MS_PER_HOUR);
    const diffDays = Math.floor(diffMs / MS_PER_DAY);

    if (diffMins < 1) {
      return "Just now";
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    if (diffDays < DAYS_PER_WEEK) {
      return `${diffDays}d ago`;
    }
    return dateObj.toLocaleDateString();
  };

  // Helper: Render a message item
  const renderMessageItem = (item: SessionItem) => (
    <div
      className={cn(
        "flex w-full",
        item.role === "user" ? "justify-end" : "justify-start"
      )}
      key={item.id}
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

  // Helper: Render auth required item
  const renderAuthItem = (item: SessionItem) => {
    if (!item.data) {
      return null;
    }
    const authData = item.data as {
      url?: string;
      providerId?: string;
      status?: string;
    };
    return (
      <OAuthAuthMessage
        configs={[
          {
            url: authData.url,
            providerId: authData.providerId,
            status: authData.status as AuthStatus | undefined,
          },
        ]}
        key={item.id}
      />
    );
  };

  // Helper: Render step event item
  const renderStepItem = (item: SessionItem) => (
    <div className="flex w-full justify-start" key={item.id}>
      <div className="max-w-[80%] rounded-lg border border-muted-foreground/20 bg-muted/50 px-4 py-2">
        <p className="font-medium text-muted-foreground text-xs">
          {item.type === "step_started" ? "Starting" : "Completed"}:{" "}
          {item.step || "step"}
        </p>
        {item.data && Object.keys(item.data).length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground text-xs">
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

  // Helper: Render error item
  const renderErrorItem = (item: SessionItem) => (
    <div className="flex w-full justify-start" key={item.id}>
      <div className="max-w-[80%] rounded-lg bg-destructive/10 px-4 py-2">
        <p className="text-destructive text-sm">Error: {item.error}</p>
      </div>
    </div>
  );

  // Helper: Render a single session item
  const renderSessionItem = (item: SessionItem) => {
    // Render messages
    if (
      item.type === "user_message" ||
      item.type === "assistant_message" ||
      item.type === "system_message"
    ) {
      return renderMessageItem(item);
    }

    // Render auth_required
    if (item.type === "auth_required") {
      return renderAuthItem(item);
    }

    // Render step events
    if (item.type === "step_started" || item.type === "step_completed") {
      return renderStepItem(item);
    }

    // Render errors
    if (item.type === "error") {
      return renderErrorItem(item);
    }

    // Skip rendering other event types
    return null;
  };

  // Input placeholder without nested ternaries
  let inputPlaceholder = "Initializing session...";
  if (sessionId) {
    if (sessionStatus !== "active" && sessionStatus !== "waiting_auth") {
      inputPlaceholder = "Agent is working, please wait...";
    } else {
      inputPlaceholder = "Type your message...";
    }
  }

  return (
    <Card className="flex h-[600px] flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Button
            className="h-8 w-8"
            onClick={handleBackToGallery}
            size="icon"
            variant="ghost"
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
            <Button className="w-full" onClick={createNewSession} size="sm">
              <Plus className="mr-2 h-4 w-4" />
              New Session
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {isLoadingSessions && (
              <div className="p-4 text-center text-muted-foreground text-sm">
                Loading sessions...
              </div>
            )}
            {!isLoadingSessions && sessions.length === 0 && (
              <div className="p-4 text-center text-muted-foreground text-sm">
                No sessions yet
              </div>
            )}
            {!isLoadingSessions && sessions.length > 0 && (
              <div className="space-y-1">
                {sessions.map((session) => (
                  <button
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                      session.sessionId === sessionId
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                    key={session.sessionId}
                    onClick={() => loadSession(session.sessionId)}
                    type="button"
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
                <p>{`Start a conversation with ${agentName}...`}</p>
              </div>
            )}
            {items.map(renderSessionItem)}
            {isLoading && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-lg bg-muted px-4 py-2">
                  <p className="text-muted-foreground text-sm">Thinking...</p>
                </div>
              </div>
            )}
            <div ref={itemsEndRef} />
          </div>
          <div className="flex gap-2 border-t px-6 py-4">
            <Input
              className="flex-1"
              disabled={
                isLoading ||
                !sessionId ||
                (sessionStatus !== "active" && sessionStatus !== "waiting_auth")
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={inputPlaceholder}
              value={input}
            />
            <Button
              disabled={
                isLoading ||
                !input.trim() ||
                !sessionId ||
                (sessionStatus !== "active" && sessionStatus !== "waiting_auth")
              }
              onClick={sendMessage}
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
