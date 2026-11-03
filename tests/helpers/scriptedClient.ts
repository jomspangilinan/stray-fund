import Anthropic from "@anthropic-ai/sdk";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Messages API bodies in a test fake */

export type ScriptedCall = { name: string; input: unknown };
export type ScriptedTurn =
  | { text?: string; calls?: ScriptedCall[]; stop?: string; before?: () => void | Promise<void> }
  | Error;

let callSeq = 0;

function messageFor(turn: Exclude<ScriptedTurn, Error>) {
  const content: unknown[] = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const c of turn.calls ?? []) {
    content.push({ type: "tool_use", id: `toolu_${++callSeq}`, name: c.name, input: c.input });
  }
  return {
    id: `msg_${++callSeq}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason: turn.stop ?? (turn.calls?.length ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * The real SDK and its real tool runner, with only the HTTP call replaced. Every tool
 * call goes through the same parse and error handling as production.
 */
export function scriptedClient(turns: ScriptedTurn[]) {
  const requests: any[] = [];
  const remaining = [...turns];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async (_url: unknown, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      const turn = remaining.shift();
      if (!turn) throw new Error("Script ran out of turns");
      if (turn instanceof Error) throw turn;
      await turn.before?.();
      return new Response(JSON.stringify(messageFor(turn)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  return {
    client,
    requests,
    /** Every tool result the model was sent, in order. */
    toolResults(): { content: string; isError: boolean }[] {
      const last = requests.at(-1);
      if (!last) return [];
      return last.messages.flatMap((m: any) =>
        m.role === "user" && Array.isArray(m.content)
          ? m.content
              .filter((b: any) => b.type === "tool_result")
              .map((b: any) => ({
                content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
                isError: b.is_error === true,
              }))
          : [],
      );
    },
  };
}
