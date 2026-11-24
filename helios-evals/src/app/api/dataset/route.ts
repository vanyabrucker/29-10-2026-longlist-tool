// Adds a chat to the replay dataset (evals/data/dataset.jsonl) by running the
// gateway's own exporter, then marks the feedback row with the sample. A local
// dev tool: it runs `uv` in the gateway folder on this machine.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { DATASET_FILE, GATEWAY_DIR, dataset } from "@/lib/data";
import { GATEWAY_URL, SESSION_COOKIE, gatewayHeaders } from "@/lib/gatewayServer";

const run = promisify(execFile);

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const me = await fetch(`${GATEWAY_URL}/me`, { headers: gatewayHeaders(token), cache: "no-store" });
  if (!me.ok || !(await me.json()).is_dev)
    return Response.json({ detail: "Devs only." }, { status: 403 });

  const { chat_id: chatId, feedback_id: feedbackId } = await request.json();
  if (typeof chatId !== "string" || !/^[0-9a-f-]{36}$/i.test(chatId))
    return Response.json({ detail: "A chat id is required." }, { status: 400 });

  let stderr = "";
  try {
    ({ stderr } = await run(
      "uv",
      ["run", "python", "-m", "evals.dataset", "export", "--chat", chatId, "--append",
        "--out", DATASET_FILE],
      { cwd: GATEWAY_DIR, timeout: 120_000 },
    ));
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return Response.json(
      { detail: `The export failed: ${(err.stderr || err.message).trim().slice(-600)}` },
      { status: 500 },
    );
  }
  // The exporter skips chats it can't replay and says why on stderr.
  if (!(await dataset()).some((s) => s.id === chatId)) {
    const why = stderr.match(/skip \S+: (.*)/)?.[1] ?? stderr.trim();
    return Response.json({ detail: `Not added: ${why || "the exporter wrote nothing."}` },
      { status: 422 });
  }
  if (typeof feedbackId === "string") {
    const headers = gatewayHeaders(token);
    headers.set("content-type", "application/json");
    const patched = await fetch(`${GATEWAY_URL}/feedback/${encodeURIComponent(feedbackId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ dataset_sample: chatId }),
      cache: "no-store",
    });
    if (!patched.ok)
      return Response.json(
        { detail: "Added to the dataset, but the feedback couldn't be marked." },
        { status: 502 },
      );
  }
  return Response.json({ sample: chatId, note: stderr.trim() || null });
}
