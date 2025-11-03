import { Arcade } from "@arcadeai/arcadejs";

// Create a singleton Arcade client instance
// The Arcade constructor looks for process.env.ARCADE_API_KEY by default
const arcadeClient = new Arcade();

export default arcadeClient;
