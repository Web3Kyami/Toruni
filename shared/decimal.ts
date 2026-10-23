export interface DecimalValue { coefficient: bigint; scale: number }
export function parseDecimal(value: string): DecimalValue | null {
  if (value.length > 100 || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const coefficient = BigInt(whole + fraction);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}
export function alignDecimals(a: DecimalValue, b: DecimalValue): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.coefficient * 10n ** BigInt(scale - a.scale), b.coefficient * 10n ** BigInt(scale - b.scale), scale];
}
export function compareDecimals(a: DecimalValue, b: DecimalValue): number {
  const [left, right] = alignDecimals(a, b);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function subtractDecimals(a: DecimalValue, b: DecimalValue): DecimalValue {
  const [left, right, scale] = alignDecimals(a, b);
  return { coefficient: left - right, scale };
}
export function multiplyDecimals(a: DecimalValue, b: DecimalValue): DecimalValue {
  return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
}
export function formatDecimal(value: DecimalValue): string {
  const negative = value.coefficient < 0n;
  const absolute = negative ? -value.coefficient : value.coefficient;
  const digits = absolute.toString().padStart(value.scale + 1, "0");
  const text = value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}` : digits;
  return `${negative ? "-" : ""}${text}`;
}
export function isDecimalMultiple(value: DecimalValue, step: DecimalValue): boolean {
  const [amount, divisor] = alignDecimals(value, step);
  return divisor > 0n && amount % divisor === 0n;
}
