// The machines prompt section: the rule that addresses a machine, the shell
// a call's command runs in, and the list the model reads.

import { describe, expect, it } from "vitest";
import { MACHINES_SECTION_HEADER, renderMachinesSection } from "../../harness/machines.js";

describe("renderMachinesSection", () => {
  it("names the shell rule, so a Windows machine is not handed bash", () => {
    expect(MACHINES_SECTION_HEADER).toContain("cmd.exe");
    expect(MACHINES_SECTION_HEADER).toContain("2>nul");
    expect(MACHINES_SECTION_HEADER).toContain("wsl.localhost");
  });

  it("ends with the machine list", () => {
    expect(
      renderMachinesSection([{ machine_id: "m-1", label: "WORKSTATION-A", online: true, os: "windows", os_version: "26H2" }]),
    ).toBe(`${MACHINES_SECTION_HEADER}\n\n- WORKSTATION-A · m-1 · online · windows 26H2 · shell: cmd.exe`);
  });

  it("says none paired when the member has no machines", () => {
    expect(renderMachinesSection([])).toBe(`${MACHINES_SECTION_HEADER}\n\nnone paired`);
  });
});
