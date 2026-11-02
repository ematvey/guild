// Runs before first paint, loaded as a blocking same-origin script so the
// content security policy needs no inline script source.

// The theme class (default: dark), so the first frame is never the wrong
// theme.
try {
  var t = localStorage.getItem("guild.theme") || "dark";
  var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {
  document.documentElement.classList.add("dark");
}

// iOS Safari ignores user-scalable=no: block its page-zoom pinch gestures
// directly, or a pinch leaves the page zoomed and pannable horizontally
// (gesturestart/change are Safari-specific events).
document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
document.addEventListener("gesturechange", function (e) { e.preventDefault(); });
