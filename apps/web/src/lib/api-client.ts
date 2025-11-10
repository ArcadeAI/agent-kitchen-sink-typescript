import { treaty } from "@elysiajs/eden";
import type { App } from "../../../server/src/app";

const API_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

export const api = treaty<App>(API_URL, {
  fetch: {
    credentials: "include",
  },
});
