// Re-initializes every agent's workspace config files from the templates.
// The seeded files are deleted first, so a run gives each agent the pristine
// template set with its own name and creation instructions. Everything else
// in the workspace (memories/, skills/, project files) is left alone.
//
//   npx tsx scripts/agents-reinit.ts                 # every org
//   npx tsx scripts/agents-reinit.ts --org <uuid>    # one org
//   npx tsx scripts/agents-reinit.ts --dry-run       # print, write nothing
//
// Env: GUILD_PG_URL (default postgres://guild:guild@127.0.0.1:5432/guild),
// GUILD_AGENT_WORKSPACE_ROOT (default /workspaces).

import { rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { CONFIG_FILES, agentWorkspaceDir, seedAgentWorkspace } from "../apps/server/src/agents/workspace-config.js";

const SEEDED = [...CONFIG_FILES.map((file) => file.name), "memories"];

interface AgentRow {
  id: string;
  org_id: string;
  name: string;
  instructions: string;
  status: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const orgIndex = args.indexOf("--org");
  const orgId = orgIndex === -1 ? null : args[orgIndex + 1];
  const url = process.env.GUILD_PG_URL ?? "postgres://guild:guild@127.0.0.1:5432/guild";
  const root = process.env.GUILD_AGENT_WORKSPACE_ROOT ?? "/workspaces";

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<AgentRow>(
      `SELECT id, org_id, name, instructions, status FROM agents
       WHERE status <> 'deleted'${orgId === null ? "" : " AND org_id = $1"}
       ORDER BY created_at`,
      orgId === null ? [] : [orgId],
    );
    console.log(`${res.rows.length} agent(s)${orgId === null ? "" : ` in org ${orgId}`}${dryRun ? " (dry run)" : ""}`);
    for (const agent of res.rows) {
      const dir = agentWorkspaceDir(root, agent.org_id, agent.id);
      const label = `${agent.name} (${agent.id})`;
      if (dryRun) {
        console.log(`  would reset ${label} at ${dir}`);
        continue;
      }
      // Remove only the seeded files: memories/ is wiped too so the birth
      // sequence starts from an empty slate, but other files stay.
      for (const name of SEEDED) {
        await rm(path.join(dir, name), { recursive: true, force: true });
      }
      const written = await seedAgentWorkspace(dir, agent);
      console.log(`  reset ${label} at ${dir}: ${written.join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
