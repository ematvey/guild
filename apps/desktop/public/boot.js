// Runs before first paint, loaded as a blocking same-origin script so the
// content security policy needs no inline script source.

// The theme class (default: dark), so the first frame is never the wrong
// theme.
try {
  const t = localStorage.getItem("guild.theme") || "dark";
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch {
  document.documentElement.classList.add("dark");
}

// iOS Safari ignores user-scalable=no: block its page-zoom pinch gestures
// directly, or a pinch leaves the page zoomed and pannable horizontally
// (gesturestart/change are Safari-specific events).
document.addEventListener("gesturestart", (e) => {
  e.preventDefault();
});
document.addEventListener("gesturechange", (e) => {
  e.preventDefault();
});
