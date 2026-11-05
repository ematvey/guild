// The composer's agent: the pick among the active agents of the pushed list,
// seeded by the open chat's binding and locked when the thread belongs to
// its agent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { bindChatAgent, chatAgentBinding, type ChatTree } from "../../../lib/api/chats";
import type { Agent } from "../../agents/agents-api";
import { useAgentList } from "../../agents/agents-store";
import { useMemberProfile } from "../../../lib/profile-store";
import { composerAgent } from "../status";

/** The agents a member's composer offers: their own personal agent and
 *  every shared one. Another member's personal agent (an admin sees them
 *  all) stays out: they share one name, and picking one by mistake runs the
 *  chat with that member's Integrations. */
export function composerAgents(agents: readonly Agent[], userId: string): Agent[] {
  return agents.filter((a) => a.status === "active" && (!a.is_personal || a.owner_user_id === userId));
}

/** The chat's bound agent from its agent read, when the reply has an
 *  agent's identity; anything else leaves the picker as it is. */
function boundAgent(value: unknown): Agent | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name } = value as Partial<Agent>;
  return typeof id === "string" && typeof name === "string" ? (value as Agent) : null;
}

export function useAgentPick(viewChatId: string | null, childTree: ChatTree | null) {
  // Every chat runs with one of the caller's agents; the composer picks
  // which, and the choice binds the chat.
  const allAgents = useAgentList();
  const me = useMemberProfile()?.id ?? null;
  // Null until both the agent list and the member's own id are known, so
  // the default never settles on someone else's personal agent.
  const agentsList = useMemo(
    () => (allAgents === null || me === null ? null : composerAgents(allAgents, me)),
    [allAgents, me],
  );
  const [pickedAgent, setPickedAgent] = useState<Agent | null>(null);
  const [agentLocked, setAgentLocked] = useState(false);
  const pickedAgentRef = useRef<Agent | null>(null);
  pickedAgentRef.current = pickedAgent;
  const personalAgent = agentsList?.find((a) => a.is_personal) ?? null;
  // The composer names the picked agent as the socket last described it,
  // so a rename shows without a refetch.
  const shownAgent = composerAgent(pickedAgent, allAgents, viewChatId !== null ? childTree : null);

  // The first list picks the default agent: the personal one.
  useEffect(() => {
    if (agentsList === null) return;
    setPickedAgent((cur) => cur ?? agentsList.find((a) => a.is_personal) ?? agentsList[0] ?? null);
  }, [agentsList]);

  // A bound chat's binding seeds the pick and the lock; a new chat keeps
  // the pick. A thread that belongs to its agent is not switchable. The
  // name shown comes from pushed state (`shownAgent`), not this read.
  useEffect(() => {
    if (viewChatId === null) {
      setAgentLocked(false);
      return;
    }
    let live = true;
    void chatAgentBinding(viewChatId)
      .then(({ agent, switcheable }) => {
        if (!live) return;
        setAgentLocked(!switcheable);
        const bound = boundAgent(agent);
        if (bound !== null) setPickedAgent(bound);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [viewChatId]);

  /** A pick from the menu: an open chat rebinds at once; a new chat binds
   *  on its first send. */
  const pickAgent = useCallback(
    (agent: Agent) => {
      setPickedAgent(agent);
      pickedAgentRef.current = agent;
      if (viewChatId !== null) {
        void bindChatAgent(viewChatId, agent.id).then((ok) => {
          if (!ok) toast.error("Could not switch the agent for this chat");
        });
      }
    },
    [viewChatId],
  );

  return { allAgents, agentsList, pickedAgent, pickedAgentRef, agentLocked, personalAgent, shownAgent, pickAgent };
}

export type AgentPick = ReturnType<typeof useAgentPick>;
