import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Calendar, CheckCircle2, Inbox } from "lucide-react";
import { Chatbot } from "@/components/chatbot";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

const AGENTS = [
  {
    id: "inbox-summarizer",
    name: "Inbox Summarizer",
    description: "Summarize your emails efficiently",
    icon: Inbox,
  },
  {
    id: "inbox-prioritizer",
    name: "Inbox Prioritizer",
    description: "Prioritize your emails and focus on what matters most",
    icon: CheckCircle2,
  },
  {
    id: "meeting-prep",
    name: "Meeting Prep",
    description: "Prepare for your meetings by analyzing relevant emails",
    icon: Calendar,
  },
] as const;

export const Route = createFileRoute("/dashboard")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    agentId: (search.agentId as string) || undefined,
  }),
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      redirect({
        to: "/login",
        throw: true,
      });
    }
    return { session };
  },
});

function RouteComponent() {
  const { session } = Route.useRouteContext();
  const { agentId } = useSearch({ from: "/dashboard" });
  const navigate = useNavigate();

  const handleAgentSelect = (id: string) => {
    navigate({
      to: "/dashboard",
      search: { agentId: id },
    });
  };

  const selectedAgent = AGENTS.find((agent) => agent.id === agentId);

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="font-bold text-3xl">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome {session.data?.user.name}
        </p>
      </div>
      {agentId && selectedAgent ? (
        <Chatbot agentId={agentId} agentName={selectedAgent.name} />
      ) : (
        <div>
          <h2 className="mb-6 font-semibold text-2xl">Select an Agent</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {AGENTS.map((agent) => {
              const Icon = agent.icon;
              return (
                <Card
                  className="cursor-pointer transition-all hover:shadow-lg"
                  key={agent.id}
                  onClick={() => handleAgentSelect(agent.id)}
                >
                  <CardHeader>
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="h-5 w-5" />
                      <CardTitle>{agent.name}</CardTitle>
                    </div>
                    <CardDescription>{agent.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button className="w-full">Start Chat</Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
