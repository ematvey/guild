// The generated thread title: one short model call, then a clean and
// bounded label. The reply is not trusted as prose.

import { deriveTitleFromMessage } from "../agents/store.js";

/** One short model call names a fresh thread. The reply is not trusted as
 *  prose: it is cleaned and bounded by `deriveTitleFromMessage`. */
export const TITLE_SYSTEM =
  "You name conversations. Reply with a title of 3 to 6 words in the language of the user's message. " +
  "Return only the title: no quotes, no trailing punctuation, no explanation.";

/** The model's title line, stripped of wrappers a chat model may add. */
export function cleanGeneratedTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "") ?? "";
  const stripped = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/[.;:,]+$/, "")
    .trim();
  return deriveTitleFromMessage(stripped);
}
