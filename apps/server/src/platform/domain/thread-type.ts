// The kind of an agent thread, shared by the agent domain and the chat
// store that creates thread chats.

/** What a thread is. A member's own conversations are `user` threads; a
 *  spawned node is `subagent`; a scheduled run's transcript is `routine`. */
export type AgentThreadType = "user" | "subagent" | "routine";
