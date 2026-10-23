export function formatUsd(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return "Unavailable";

  const fraction = match[3] ?? "";
  let cents = BigInt(match[2]!) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if ((fraction[2] ?? "0") >= "5") cents += 1n;
  const negative = match[1] === "-" && cents > 0n;
  const amount = `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}$${amount}`;
}
