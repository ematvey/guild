// The kind of an agent thread, shared by the agent domain and the chat
// store that creates thread chats.

/** What a thread is. The user's own conversations are `user` threads; a
 *  spawned node is `subagent`; a scheduled run's transcript is `routine`.
 *  The default thread is a user thread with `is_default` set. */
export type AgentThreadType = "user" | "subagent" | "routine";
