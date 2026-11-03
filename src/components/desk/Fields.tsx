"use client";

import { useFieldError } from "../ActionForm";

/** A labelled text box. A missing value is named right under it. */
export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required = true,
  hint,
  missing,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  hint?: string;
  /** What to say when it is left empty. */
  missing?: string;
}) {
  const error = useFieldError(name);
  return (
    <label className="grid gap-1">
      <span className="font-bold">{label}</span>
      {hint && <span className="small soft">{hint}</span>}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        data-missing={missing}
        className="field"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
      />
      {error && (
        <span id={`${name}-error`} role="alert" className="small font-bold text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

/** The "Cat" menu on a photo that needs sorting. */
export function CatPicker({ options, suggested, defaultValue }: { options: { id: string; label: string }[]; suggested: { id: string; label: string }[]; defaultValue: string }) {
  const error = useFieldError("catId");
  return (
    <label className="grid gap-1">
      <span className="font-bold">Cat</span>
      <select
        name="catId"
        className="field"
        required
        data-missing="Choose a cat."
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "catId-error" : undefined}
      >
        <option value="" disabled>
          Choose a cat
        </option>
        {suggested.map((c) => (
          <option key={c.id} value={c.id}>
            Suggested: {c.label}
          </option>
        ))}
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {error && (
        <span id="catId-error" role="alert" className="small font-bold text-danger">
          {error}
        </span>
      )}
    </label>
  );
}
