// The skills route carries the shown file and the catalog's search, filter
// and sort: each round-trips through the address, defaults stay bare.
import { describe, expect, it } from "vitest";
import { applyRoutePatch, parseChatRoute } from "../thread/route";
import { routePath } from "../thread/hooks/use-thread-route";
import {
  parseSkillsRoute,
  skillsPageState,
  skillsRoutePath,
  SKILLS_CATALOG,
  withCatalogQuery,
  withSkillFile,
  type SkillsRoute,
} from "./skills-route";

const roundTrip = (path: string) => {
  const [pathname, search = ""] = path.split("?");
  const route = parseChatRoute(pathname!, search ? `?${search}` : "");
  return routePath(route);
};

describe("skills route: files and catalog query", () => {
  it("round-trips the file a detail or editor shows", () => {
    for (const path of [
      "/skills/code-review/files/scripts/run.sh",
      "/skills/code-review/edit/files/docs/a%20b.md",
      "/skills/new/files/notes.md",
      "/skills/code-review",
      "/skills/code-review/edit",
    ]) {
      expect(roundTrip(path)).toBe(path);
    }
    expect(parseSkillsRoute(["code-review", "files", "scripts", "run.sh"])).toEqual({
      view: "catalog",
      slug: "code-review",
      editor: null,
      file: "scripts/run.sh",
    });
  });

  it("names SKILL.md by the bare address", () => {
    expect(parseSkillsRoute(["code-review", "files", "SKILL.md"]).file).toBeUndefined();
    const detail: SkillsRoute = { view: "catalog", slug: "x", editor: null };
    expect(withSkillFile(detail, "SKILL.md")).toEqual(detail);
    expect(skillsRoutePath(withSkillFile(detail, "a/b.md"))).toBe("/skills/x/files/a/b.md");
    expect(skillsPageState(detail).file).toBe("SKILL.md");
  });

  it("round-trips the catalog query, omitting defaults", () => {
    expect(roundTrip("/skills?q=review&filter=mine&sort=az")).toBe("/skills?q=review&filter=mine&sort=az");
    expect(roundTrip("/skills?filter=all&sort=installs")).toBe("/skills");
    expect(roundTrip("/skills?filter=bogus")).toBe("/skills");
    expect(skillsPageState(SKILLS_CATALOG).catalog).toEqual({ q: "", filter: "all", sort: "installs" });
  });

  it("changes one query field at a time and drops back to the bare address", () => {
    const typed = withCatalogQuery(SKILLS_CATALOG, { q: "rev" });
    expect(skillsRoutePath(typed)).toBe("/skills?q=rev");
    expect(skillsRoutePath(withCatalogQuery(typed, { sort: "updated" }))).toBe("/skills?q=rev&sort=updated");
    expect(withCatalogQuery(typed, { q: "" })).toEqual(SKILLS_CATALOG);
  });

  it("keeps the query on a detail opened from the list, so Back returns to it", () => {
    const route = parseChatRoute("/skills/x", "?q=rev");
    expect(route.skills?.catalog?.q).toBe("rev");
    expect(routePath(route)).toBe("/skills/x?q=rev");
    const back = applyRoutePatch(route, {
      skills: { view: "catalog", slug: null, editor: null, catalog: route.skills!.catalog },
    });
    expect(routePath(back)).toBe("/skills?q=rev");
  });

  it("tabs carry no query or file", () => {
    expect(roundTrip("/skills/activity?q=x")).toBe("/skills/activity");
    expect(roundTrip("/skills/machine")).toBe("/skills/machine");
  });
});
