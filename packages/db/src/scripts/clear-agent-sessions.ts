import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import prisma from "../index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverEnvPath = path.resolve(__dirname, "../../../../apps/server/.env");

if (fs.existsSync(serverEnvPath)) {
  dotenv.config({ path: serverEnvPath });
} else {
  dotenv.config();
}

async function clearAgentSessions() {
  const deletedSessionItems = await prisma.sessionItem.deleteMany();
  const deletedAgentSessions = await prisma.agentSession.deleteMany();

  return {
    sessionItems: deletedSessionItems.count,
    agentSessions: deletedAgentSessions.count,
  };
}

async function main() {
  console.log("Clearing agent sessions…");

  const { sessionItems, agentSessions } = await clearAgentSessions();

  console.log(
    `Deleted ${agentSessions} agent session${
      agentSessions === 1 ? "" : "s"
    } and ${sessionItems} session item${sessionItems === 1 ? "" : "s"}.`
  );
}

main()
  .catch((error) => {
    console.error("Failed to clear agent sessions:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
