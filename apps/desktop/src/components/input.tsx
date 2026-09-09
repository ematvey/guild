import * as React from "react";
import { cn } from "../lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-sm outline-none placeholder:text-neutral-500 focus:border-neutral-500",
        className,
      )}
      {...props}
    />
  );
}
