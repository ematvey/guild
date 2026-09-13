//! Field — a form field: label, control, optional hint. Replaces the ad-hoc
//! uppercase `<p>` labels sections used before; one spacing rhythm for all
//! settings forms.

import React, { cloneElement, isValidElement, useId, type ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  // Associate the label with the control: the id is minted here and cloned
  // onto the (single) child element unless it already carries one.
  const id = useId();
  const childId = isValidElement<{ id?: string }>(children) ? children.props.id : undefined;
  const control =
    isValidElement(children) && childId === undefined
      ? cloneElement(children as React.ReactElement<{ id?: string }>, { id })
      : children;
  return (
    <div className={className}>
      <label htmlFor={childId ?? id} className="mb-1.5 block text-sm font-medium leading-none">
        {label}
      </label>
      {control}
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
