// In-app folder browser for a WSL distro (the create-project dialog's path
// specifier, spec §5): the shared body lists through the app process over
// \\wsl.localhost\<distro>\, and the confirmed folder is the UNC path.

import { listDir, wslHome } from "../../lib/api/folders";
import { FolderBrowser } from "./FolderBrowser";
import { wslFolder } from "./projects";

export function PathSpecifier({
  distro,
  existingFor,
  onConfirm,
}: {
  distro: string;
  /** Matches a folder against the caller's existing projects — the Confirm
   * button reads "Open project" when the browsed folder is one. */
  existingFor?: (folder: string) => unknown;
  /** Called with the confirmed folder (UNC path, canonical). */
  onConfirm: (folder: string) => void;
}) {
  return (
    <FolderBrowser
      source={distro}
      home={() => wslHome(distro)}
      list={(path) => listDir(wslFolder(distro, path))}
      canonical={(path) => wslFolder(distro, path)}
      errorSuffix={(error) =>
        error.includes("wsl") || error.toLowerCase().includes("network")
          ? " — the distro may be stopped; retrying usually starts it."
          : ""
      }
      existingFor={existingFor}
      onConfirm={onConfirm}
    />
  );
}
