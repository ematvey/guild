// @openuidev/react-lang mounts its inspector in development builds, loading
// it from a public CDN. Its own guard flag, set before the package
// evaluates, keeps it out: the app loads no third-party script.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

export {};
