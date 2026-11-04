// Markdown an integration ships: its README (the landing page people read)
// and the short "how to get it" notes beside credentials. Links open
// externally and images never load (the shared markdown components).

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";

/** Document rhythm for a README: reading-size paragraphs with a reading
 *  line height, section headings on the section-title step. */
const README_CLASS =
  "text-base leading-[1.75] text-foreground/90 " +
  "[&_h1]:mb-3 [&_h1]:mt-10 [&_h1]:text-lg [&_h1]:text-foreground " +
  "[&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:text-foreground " +
  "[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:text-foreground " +
  "[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&>*:first-child]:mt-0";

/** Note rhythm: metadata-size, tight. */
const NOTE_CLASS =
  "text-xs leading-relaxed text-muted-foreground [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&>*:first-child]:mt-0";

export function Readme({ markdown }: { markdown: string }) {
  return (
    <div className={`${MD_CLASS} ${MD_TABLE_CLASS} ${README_CLASS}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {markdown}
      </Markdown>
    </div>
  );
}

export function Note({ markdown }: { markdown: string }) {
  return (
    <div className={`${MD_CLASS} ${NOTE_CLASS}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {markdown}
      </Markdown>
    </div>
  );
}
