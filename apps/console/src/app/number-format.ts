const TOKEN_UNITS = [
  { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, suffix: 'T' },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: 'M' },
  { threshold: 1_000, divisor: 1_000, suffix: 'K' },
];

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const absoluteValue = Math.abs(value);
  const unit = TOKEN_UNITS.find((candidate) => absoluteValue >= candidate.threshold);
  if (!unit) return new Intl.NumberFormat('en-US').format(value);

  const scaledValue = value / unit.divisor;
  const roundedValue = Math.round(scaledValue * 10) / 10;
  if (roundedValue >= 1_000) {
    const nextUnit = TOKEN_UNITS[TOKEN_UNITS.indexOf(unit) - 1];
    if (nextUnit) {
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(
        value / nextUnit.divisor,
      )}${nextUnit.suffix}`;
    }
  }

  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(
    scaledValue,
  )}${unit.suffix}`;
}
