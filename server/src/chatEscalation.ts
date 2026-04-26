/** Demo toll-free style number; override with DEMO_CARE_PHONE in .env */
export function demoCarePhone(): string {
  return (process.env.DEMO_CARE_PHONE || "1800-200-1234").trim();
}

const UNCERTAIN_RE = /\[\[UNCERTAIN\]\]/gi;

export function stripUncertainTag(answer: string): { text: string; uncertain: boolean } {
  if (!/\[\[UNCERTAIN\]\]/i.test(answer)) {
    return { text: answer, uncertain: false };
  }
  const text = answer.replace(UNCERTAIN_RE, "").trimEnd();
  return { text, uncertain: true };
}

export function escalationFooter(chatId: string): string {
  const phone = demoCarePhone();
  return [
    "",
    "---",
    "**Need a human?** (demo)",
    `If this answer is not enough, call **Tata Airways Care: ${phone}** (India toll-free, 24×7 demo line).`,
    `Please **Save chat as PDF** from the Recovery Copilot panel and quote **Chat ID: \`${chatId}\`** so the executive can follow up.`,
    "---",
  ].join("\n");
}
