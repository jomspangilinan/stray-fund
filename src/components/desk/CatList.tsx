import Link from "next/link";
import { ActionForm } from "../ActionForm";
import type { CaretakerQueue } from "@/server/caretaker/queue";
import { STATUS_LABEL } from "@/server/public";
import { Hidden } from "./Fields";

const SEX_OPTIONS = ["unknown", "female", "male"] as const;
const FLAG_OPTIONS = ["pregnant", "injured", "sick", "kitten"] as const;

/** Sex, flags and the last steps for each cat. A name is changed on the cat's own card, with the pencil. */
export function CatList({ cats }: { cats: CaretakerQueue["catChoices"] }) {
  return (
    <section className="mt-8" aria-label="Cats">
      <p className="small soft">The 200 newest cats. To change a name, open the cat and tap the pencil.</p>
      <ul className="mt-4 grid gap-3">
        {cats.map((c) => (
          <li key={c.id} className="card">
            <h2 className="text-base font-extrabold">
              <Link href={`/cats/${c.id}`} className="link !min-h-11">
                {c.name}
              </Link>{" "}
              <span className="font-normal soft">{STATUS_LABEL[c.status] ?? c.status}</span>
            </h2>
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
              <fieldset className="flex flex-wrap gap-4">
                <legend className="font-bold">Flags</legend>
                {FLAG_OPTIONS.map((f) => (
                  <label key={f} className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="flags[]" value={f} defaultChecked={c.flags.includes(f)} className="h-5 w-5" />
                    {f}
                  </label>
                ))}
              </fieldset>
            </ActionForm>
            {c.status === "spotted" || c.status === "queued" ? (
              <ActionForm action="cat_set_ear_tip" submitLabel="Ear is tipped, already neutered" quiet>
                <Hidden name="catId" value={c.id} />
                <Hidden name="earTip" value="present" />
              </ActionForm>
            ) : null}
            {c.status === "neutered" && (
              <ActionForm action="cat_adoptable" submitLabel="Mark ready for a home" quiet>
                <Hidden name="catId" value={c.id} />
              </ActionForm>
            )}
            {c.status === "adoptable" && (
              <ActionForm action="cat_adopted" submitLabel="Mark adopted" quiet>
                <Hidden name="catId" value={c.id} />
              </ActionForm>
            )}
            {c.status === "spotted" && c.plainOnly && (
              <ActionForm
                action="cat_remove"
                submitLabel="Remove this cat"
                quiet
                confirm={{ question: `Remove ${c.name} and its photos? This can't be undone.`, send: "Remove" }}
              >
                <Hidden name="catId" value={c.id} />
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
