// The guild prompt section's current-user block: the Guild account a thread
// belongs to, so a tool that resolves "me" through its own credentials (Jira
// currentUser(), a mailbox) can be checked against the name it returns.

import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import {
  buildSystemPrompt,
  createGuildExtension,
  DEFAULT_PERSONA,
  renderCurrentUser,
  type CurrentUser,
  type GuildExtensionDeps,
} from "../../harness/extension.js";

const CTX = {} as Context;
const INPUT = { conversationId: 7 } as never;

const DMITRY: CurrentUser = {
  id: "user-1",
  email: "dana@example.test",
  display_name: "Dana Tester",
  role: "member",
};

function extensionDeps(user: CurrentUser | null, orgId: string | null = "org-1"): GuildExtensionDeps {
  return {
    orgPrompt: async () => null,
    orgOfConversation: async () => orgId,
    userOfConversation: async () => user,
  } as unknown as GuildExtensionDeps;
}

async function renderGuild(deps: GuildExtensionDeps): Promise<string> {
  const extension = createGuildExtension(deps);
  const section = extension.sections?.find((s) => s.key === "guild");
  expect(section).toBeDefined();
  return (await section!.render(INPUT, CTX)) as string;
}

describe("guild section current user", () => {
  it("names the account with its display name and email", async () => {
    const body = await renderGuild(extensionDeps(DMITRY));
    expect(body.startsWith(buildSystemPrompt(null))).toBe(true);
    expect(body).toContain(
      '<current_user name="Dana Tester" email="dana@example.test">',
    );
    expect(body).toContain("You are talking to Dana Tester <dana@example.test>");
    expect(body).toContain("Jira currentUser()");
    expect(body).toContain("</current_user>");
  });

  it("falls back to the email when the display name is blank", () => {
    expect(renderCurrentUser({ ...DMITRY, display_name: "  " })).toContain(
      'name="dana@example.test"',
    );
  });

  it("escapes attribute-breaking characters in the name", () => {
    const block = renderCurrentUser({ ...DMITRY, display_name: 'A "B" <c> & d' });
    expect(block).toContain(
      'name="A &quot;B&quot; &lt;c&gt; &amp; d"',
    );
    expect(block).not.toContain('<current_user name="A "B"');
  });

  it("renders the persona alone when the conversation has no owner", async () => {
    expect(await renderGuild(extensionDeps(null))).toBe(buildSystemPrompt(null));
  });

  it("keeps the org persona ahead of the block", async () => {
    const deps = { ...extensionDeps(DMITRY), orgPrompt: async () => "You are terse." };
    const body = await renderGuild(deps);
    expect(body.startsWith(buildSystemPrompt("You are terse."))).toBe(true);
    expect(body).toContain("<current_user");
    expect(DEFAULT_PERSONA).not.toBe("You are terse.");
  });
});
