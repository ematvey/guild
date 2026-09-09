import * as React from "react";
import { cn } from "../lib/utils";

const variants = {
  default: "bg-indigo-600 text-white hover:bg-indigo-500",
  outline: "border border-neutral-700 bg-transparent hover:bg-neutral-900",
};

export function Button({
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
