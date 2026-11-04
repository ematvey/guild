// A connector source with an empty registry: only the built-ins resolve.

import type { ConnectorSource } from "../../integrations/connectors.js";

export const NO_REGISTRY: ConnectorSource = {
  registry: {
    approvedBundle: async () => null,
    getVersion: async () => {
      throw new Error("no registry in this test");
    },
    listItems: async () => [],
  },
  objects: {
    get: async () => {
      throw new Error("no object store in this test");
    },
  },
};
