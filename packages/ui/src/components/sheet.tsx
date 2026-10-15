import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "../lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

function SheetContent({
  className,
  children,
  side = "left",
  hideClose = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "bottom" | "left" | "right";
  /** Omit the built-in corner close — for sheets whose content provides
   *  its own (the mobile sidebar's header close would otherwise sit on
   *  top of the panel's new-thread button). */
  hideClose?: boolean;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <SheetPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-card shadow-lg outline-none transition ease-in-out",
          side === "left" && "inset-y-0 left-0 h-full w-72 border-r border-border",
          side === "right" && "inset-y-0 right-0 h-full w-72 border-l border-border",
          side === "top" && "inset-x-0 top-0 border-b border-border",
          side === "bottom" && "inset-x-0 bottom-0 border-t border-border",
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm outline-none opacity-70 transition-opacity hover:opacity-100">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn("font-semibold text-foreground", className)} {...props} />;
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle, SheetDescription };
