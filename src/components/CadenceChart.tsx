import {
  Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';

export interface CadencePoint {
  weekStart: string;
  label: string;
  published: number;
}

const VIOLET = '#5b4b8a';
const INK_3 = '#7c746a';
const RULE = '#e3ddd3';
const SURFACE = '#fffdfa';

/**
 * Publishing cadence across the program. One series, one hue. The second
 * colour a stacked "measured vs unmeasured" split would need cannot be drawn from
 * this palette without either failing the chroma floor or shouting over the page,
 * so measurement coverage is reported as a figure beside the chart instead.
 */
export function CadenceChart({ data }: { data: CadencePoint[] }) {
  const max = Math.max(1, ...data.map((d) => d.published));

  return (
    <div className="chart-frame">
      <ResponsiveContainer width="100%" height={188}>
        <BarChart data={data} margin={{ top: 18, right: 4, bottom: 0, left: -24 }}>
          <CartesianGrid stroke={RULE} vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: RULE }}
            tick={{ fill: INK_3, fontSize: 11 }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            allowDecimals={false}
            domain={[0, Math.max(2, max)]}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: INK_3, fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: 'rgba(91, 75, 138, 0.07)' }}
            contentStyle={{
              background: SURFACE,
              border: `1px solid ${RULE}`,
              borderRadius: 2,
              fontSize: 12,
              fontFamily: 'Inter, system-ui, sans-serif',
              color: '#1f1d1a',
            }}
            labelFormatter={(label) => `Week of ${String(label)}`}
            formatter={(value) => {
              const n = Number(value);
              return [`${n} ${n === 1 ? 'item' : 'items'}`, 'Published'];
            }}
          />
          <Bar
            dataKey="published"
            fill={VIOLET}
            radius={[4, 4, 0, 0]}
            maxBarSize={22}
            // A 2px surface-coloured edge keeps adjacent bars from merging when the
            // publishing cadence is dense. Set on the Bar itself: per-point <Cell>
            // children override the parent fill and render the bars invisible.
            stroke={SURFACE}
            strokeWidth={2}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="published"
              position="top"
              fill={INK_3}
              fontSize={11}
              formatter={(value) => (Number(value) > 0 ? String(value) : '')}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="chart-caption">
        How many posts you published each week across the program. This counts what you
        have added to the content log, not what the platforms say.
      </p>
    </div>
  );
}
