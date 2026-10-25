// In-app folder browser for a REMOTE machine (the create-project dialog's
// path specifier): the shared body lists through the server to the machine
// socket (read-only control-plane op), and the paths are the machine's own
// Linux paths — no UNC layer.

import { listRemoteDir, remoteHome } from "../../lib/api/folders";
import { FolderBrowser } from "./FolderBrowser";
import { linuxCanonical } from "./projects";

export function RemotePathSpecifier({
  machineId,
  existingFor,
  onConfirm,
}: {
  machineId: string;
  /** Matches a folder against the caller's existing projects — the Confirm
   * button reads "Open project" when the browsed folder is one. */
  existingFor?: (folder: string) => unknown;
  /** Called with the confirmed folder (canonical Linux path). */
  onConfirm: (folder: string) => void;
}) {
  return (
    <FolderBrowser
      source={machineId}
      home={() => remoteHome(machineId)}
      list={(path) => listRemoteDir(machineId, path)}
      canonical={linuxCanonical}
      existingFor={existingFor}
      onConfirm={onConfirm}
    />
  );
}
