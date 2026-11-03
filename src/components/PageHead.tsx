/** The top of an app screen: where you are, and one plain line about it. Not a hero. */
export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="pt-2">
      <h1 className="title">{title}</h1>
      {children && <p className="mt-1.5 max-w-[46ch] soft">{children}</p>}
    </div>
  );
}
