import { cn } from "@/lib/utils";

export function Metric({
  label,
  value,
  sub,
  accent,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="eyebrow mb-1 truncate">{label}</div>
      <div className="metric truncate" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Sparkline({
  values,
  color = "#c8f169",
  className,
}: {
  values: number[];
  color?: string;
  className?: string;
}) {
  const data = values.length ? values : [0, 0, 0, 0];
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data
    .map((value, index) => {
      const x = (index / Math.max(1, data.length - 1)) * 100;
      const y = 28 - ((value - min) / range) * 24;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full", className)}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        opacity="0.9"
      />
      <polyline
        points={`0,30 ${points} 100,30`}
        fill={color}
        opacity="0.08"
        stroke="none"
      />
    </svg>
  );
}
