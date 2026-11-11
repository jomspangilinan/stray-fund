import { PageSwitch } from "../PageSwitch";

const PAGES = [
  { href: "/caretaker", label: "To check" },
  { href: "/caretaker/cats", label: "Cats" },
  { href: "/caretaker/rules", label: "Rules" },
];

/** The three caretaker screens: what to check, the cat list, the spending rules. */
export function DeskNav({ current }: { current: string }) {
  return <PageSwitch label="Caretaker desk" pages={PAGES} current={current} />;
}
