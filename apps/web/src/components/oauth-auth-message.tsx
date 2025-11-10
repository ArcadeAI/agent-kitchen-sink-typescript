import { Lock, ExternalLink, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AuthStatus = "not_started" | "pending" | "completed" | "failed" | undefined;

interface OAuthAuthMessageProps {
  configs: {
    url?: string;
    providerId?: string;
    status?: AuthStatus;
  }[];
}

export function OAuthAuthMessage({ configs }: OAuthAuthMessageProps) {
  const pendingConfigs = configs.filter(
    (config) =>
      config.status !== "completed" &&
      config.url &&
      config.providerId
  );
  const completedConfigs = configs.filter(
    (config) => config.status === "completed" && config.providerId
  );

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[80%] rounded-lg border-2 border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-500/30 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex-shrink-0">
            <Lock className="h-5 w-5 text-amber-600 dark:text-amber-500" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Authorization Required
              </p>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                {pendingConfigs.length > 0
                  ? `The agent requires you to authorize the integrations. Please click the
                URL${pendingConfigs.length > 1 ? "s" : ""} below to continue:`
                  : "All integrations have been authorized."}
              </p>
            </div>
            {completedConfigs.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                  Authorized Integrations:
                </p>
                {completedConfigs.map((config, index) => (
                  <div
                    key={index}
                    className="flex w-full items-center justify-between rounded-md border border-green-300 bg-green-50/50 px-3 py-2 dark:border-green-700 dark:bg-green-950/30"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-green-900 dark:text-green-100">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      {`Integration with ${config.providerId}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {pendingConfigs.length > 0 && (
              <div className="space-y-2">
                {completedConfigs.length > 0 && (
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    Pending Authorizations:
                  </p>
                )}
                {pendingConfigs.map((config, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    className="w-full justify-between border-amber-300 bg-white text-left hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:hover:bg-amber-950/60"
                    asChild
                  >
                    <a
                      href={config.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2"
                    >
                      <span className="flex-1 truncate text-sm font-medium text-amber-900 dark:text-amber-100">
                        {`Authorize Integration with ${config.providerId}`}
                      </span>
                      <ExternalLink className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                    </a>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}