// Pointer drag from mousedown to mouseup, for the drag-resizable columns.
// The move runs on every pointer move; the end commits once.

export function trackDrag(move: (clientX: number) => void, end: () => void): void {
  const onMove = (ev: MouseEvent) => move(ev.clientX);
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    end();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
