import { SignIn } from "./SignIn";

/**
 * What a signed-out visitor sees on Spot, Donate and Helped: what the page does, then a typed name. In the demo
 * the Neighbour button in the demo bar is the one-tap way in, so this page does not offer a second one.
 * Signing in refreshes this same page, so the person lands where they were headed.
 */
export function SignInGate({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 grid gap-5">
      <div className="grid gap-2">{children}</div>
      <div className="card grid gap-4">
        <SignIn username={null} inline />
      </div>
    </div>
  );
}
