import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway HOME with fake Claude Code and Antigravity histories. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "applock-test-"));
  const home = join(root, "applock");
  const claude = join(root, "claude-projects");
  const ag = join(root, "antigravity");
  const proj = join(claude, "-Users-me-secret-project");
  mkdirSync(join(proj, "sess-aaaa-1111"), { recursive: true });
  const line = (o) => JSON.stringify(o) + "\n";
  writeFileSync(
    join(proj, "sess-aaaa-1111.jsonl"),
    line({ type: "user", message: { role: "user", content: "Help me plan a surprise party" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Sure! Who is it for?" }] } }) +
      line({ type: "custom-title", customTitle: "Surprise party plan" }),
  );
  writeFileSync(join(proj, "sess-aaaa-1111", "tool-result.txt"), "side data");
  writeFileSync(
    join(proj, "sess-bbbb-2222.jsonl"),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "Refactor the billing module" }] } }) +
      line({ type: "ai-title", aiTitle: "Billing refactor" }),
  );
  writeFileSync(join(proj, "sess-cccc-3333.jsonl"), line({ type: "user", message: { role: "user", content: "What is 2+2?" } }));
  mkdirSync(join(ag, "conversations"), { recursive: true });
  mkdirSync(join(ag, "brain", "agconv-12345678"), { recursive: true });
  writeFileSync(join(ag, "conversations", "agconv-12345678.pb"), Buffer.from([8, 1, 18, 3, 97, 98, 99]));
  writeFileSync(join(ag, "brain", "agconv-12345678", "task.md"), "# Medical results summary\n\n- private notes");
  const env = {
    APPLOCK_HOME: home,
    APPLOCK_CLAUDE_DIR: claude,
    APPLOCK_ANTIGRAVITY_DIRS: ag,
    APPLOCK_BRIDGE_PORT: String(40000 + Math.floor(Math.random() * 20000)),
  };
  return { root, home, claude, proj, ag, env };
}
