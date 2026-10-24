// A thread's fallback name: the first user message, shortened to a readable
// label. The same rule runs on the server for agent threads and child
// sessions, so a chat does not switch naming style when it gets an agent.

const MAX_WORDS = 6;
const MAX_CHARS = 60;

/** Short, markdown-stripped thread title from the first non-empty line of a
 *  user message. Never the placeholder "New chat". */
export function threadTitleFromMessage(message: string): string {
  const first = message.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const text = first
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "";

  const words = text.split(" ");
  let title = words.slice(0, MAX_WORDS).join(" ");
  let cut = words.length > MAX_WORDS;
  if (title.length > MAX_CHARS) {
    const stem = title.slice(0, MAX_CHARS - 1);
    const space = stem.lastIndexOf(" ");
    title = (space >= MAX_CHARS / 2 ? stem.slice(0, space) : stem).replace(/[\s,;:.\-–—]+$/, "");
    cut = true;
  }
  if (cut) title = title.replace(/[\s,;:.\-–—]+$/, "") + "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}
