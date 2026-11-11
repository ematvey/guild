// The server process's answers to `MachineFacts`: the hub holds every
// machine socket, so liveness is a map lookup and the home is one
// `fs_home` request on the machine's own link. A worker asks the server the
// same two questions over IPC (worker/machine-facts.ts).

import type { MachineDispatchHost } from "./dispatch.js";
import { MachineTargetError, type MachineFacts } from "./targets.js";

const HOME_TIMEOUT_MS = 10_000;

export function hubMachineFacts(hub: Pick<MachineDispatchHost, "machineOnline" | "machineRequest">): MachineFacts {
  return {
    async online(_orgId, machineIds) {
      return new Set(machineIds.filter((machineId) => hub.machineOnline(machineId)));
    },

    async home(orgId, machineId) {
      const result = await hub.machineRequest(machineId, orgId, "fs_home", null, HOME_TIMEOUT_MS);
      if (!result.ok) {
        if (result.error.kind === "offline") throw new MachineTargetError("machine offline");
        throw new MachineTargetError(
          `the machine did not report its home folder: ${result.error.message ?? result.error.kind}`,
        );
      }
      const value = result.value as { home?: unknown } | null;
      const home = typeof value?.home === "string" ? value.home : "";
      if (home === "") throw new MachineTargetError("the machine reported no home folder");
      return home;
    },
  };
}
