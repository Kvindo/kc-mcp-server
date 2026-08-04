/** One-line stderr audit trail for write/delete tool calls — see the plan's "known v1 limitation"
 * note: the write/delete env-var gates are process-wide, not per-call, so this is the only local
 * trail of what a session actually did while writes were enabled. */
export function auditLog(redact: (text: string) => string, tool: string, type: string, detail: string): void {
  const line = `[audit] ${new Date().toISOString()} tool=${tool} type=${type} ${detail}`;
  process.stderr.write(redact(line) + "\n");
}
