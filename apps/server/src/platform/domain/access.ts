// The admin-or-owner read rule every owner-scoped surface shares (chats,
// traces, calls): an org admin reads every row of the org, a member only
// the rows they own.

type Viewer = { readonly id: string; readonly role: string };

/** Whether the viewer reads every row of the org. */
export function readsWholeOrg(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/** The owner filter a list read applies: none for an admin, the viewer's
 *  own id for a member. */
export function ownerScope(viewer: Viewer): string | undefined {
  return readsWholeOrg(viewer) ? undefined : viewer.id;
}

/** Whether the viewer may read one row owned by `ownerId`. */
export function canReadOwned(viewer: Viewer, ownerId: unknown): boolean {
  return readsWholeOrg(viewer) || ownerId === viewer.id;
}
