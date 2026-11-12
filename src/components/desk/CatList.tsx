import { ActionForm } from "../ActionForm";
import type { CaretakerQueue } from "@/server/caretaker/queue";
import { Hidden } from "./Fields";

const SEX_OPTIONS = ["unknown", "female", "male"] as const;
const FLAG_OPTIONS = ["pregnant", "injured", "sick", "kitten"] as const;

/** One cat's sex and flags. The cats browser puts it on the cat's profile. */
export function CatEdit({ c }: { c: CaretakerQueue["catChoices"][number] }) {
  return (
    <ActionForm action="cat_set_details" submitLabel="Save sex and flags" quiet>
      <Hidden name="catId" value={c.id} />
      {c.sexUnconfirmed && <p className="small soft">A neighbour said {c.sex}. Saving confirms it.</p>}
      <label className="grid gap-1">
        <span className="font-bold">Sex</span>
        <select name="sex" className="field" defaultValue={c.sex}>
          {SEX_OPTIONS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="font-bold">Flags</legend>
        {FLAG_OPTIONS.map((f) => (
          <label key={f} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="flags[]" value={f} defaultChecked={c.flags.includes(f)} className="h-5 w-5" />
            {f}
          </label>
        ))}
      </fieldset>
    </ActionForm>
  );
}

/**
 * Remove, for a cat that a plain public photo made by mistake. Shown only while the cat is spotted and every one of
 * its photos is a plain public photo; cat_remove checks everything again and refuses a cat with any history.
 */
export function CatRemove({ c, status }: { c: CaretakerQueue["catChoices"][number]; status: string }) {
  if (status !== "spotted" || !c.plainOnly) return null;
  return (
    <ActionForm action="cat_remove" submitLabel="Remove this cat" quiet confirm={{ question: `Remove ${c.name} and its photos? This can't be undone.`, send: "Remove" }}>
      <Hidden name="catId" value={c.id} />
    </ActionForm>
  );
}
