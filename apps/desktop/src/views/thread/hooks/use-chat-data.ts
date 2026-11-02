// The thread view's sidebar data, read from the chat stores the member
// socket writes: chat rows and their live status overlay, subagent trees,
// archived chats, projects and machines.
import {
  archivedChatsStore,
  archivedProjectsStore,
  chatsStore,
  chatStatusStore,
  projectsStore,
  subagentTreesStore,
} from "../chat-stores";
import type { ChatStatus } from "../status";
import { useMachines } from "../../../lib/machines-store";

export type { ChatStatus };

export function useChatData() {
  return {
    chats: chatsStore.use(),
    chatStatus: chatStatusStore.use(),
    subagentTrees: subagentTreesStore.use(),
    archivedChats: archivedChatsStore.use(),
    projects: projectsStore.use(),
    archivedProjects: archivedProjectsStore.use(),
    // The machine registry is shared app state (machines-store): the
    // socket's workspace push replaces it and presence frames patch it.
    machines: useMachines(),
  };
}
