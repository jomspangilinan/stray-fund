/*
 * The courtyard behind the cats. One made-up place: a teal wall with an arched gate, paving, a bowl.
 * Each stage adds to it and nothing is ever taken away. Purely decorative, so hidden from assistive tech.
 */

const WALL = "#7fb2b4";
const WALL_DEEP = "#5f969b";
const GATE = "#3f7a80";
const FLOOR = "#e9dec9";
const STONE = "#d9cbb1";
const LEAF = "#4f9a6a";
const LEAF_LIGHT = "#79bd84";
const POT = "#c9795f";

export function YardScene({ stage }: { stage: 0 | 1 | 2 | 3 }) {
  return (
    <svg viewBox="0 40 390 360" preserveAspectRatio="xMidYMid slice" className="yard-art" aria-hidden="true" focusable="false">
      <rect width="390" height="400" fill={FLOOR} />
      <rect width="390" height="188" fill={WALL} />
      <rect y="150" width="390" height="38" fill={WALL_DEEP} />
      <path d="M150 188 V120 a45 45 0 0 1 90 0 V188 Z" fill={GATE} />
      <path d="M163 188 V124 a32 32 0 0 1 64 0 V188 Z" fill="#2f666c" />
      <circle cx="62" cy="96" r="26" fill={WALL_DEEP} />
      <circle cx="62" cy="96" r="19" fill="#b9dcd8" />
      <path d="M62 77 V115 M43 96 H81" stroke={WALL_DEEP} strokeWidth="3" />
      <rect x="318" y="84" width="40" height="52" rx="20" fill={WALL_DEEP} />
      <rect x="324" y="90" width="28" height="40" rx="14" fill="#b9dcd8" />

      {/* paving, loose rows that widen toward the front */}
      <g fill={STONE}>
        <rect x="14" y="204" width="70" height="18" rx="9" />
        <rect x="104" y="204" width="86" height="18" rx="9" />
        <rect x="214" y="204" width="60" height="18" rx="9" />
        <rect x="296" y="204" width="82" height="18" rx="9" />
        <rect x="-8" y="244" width="96" height="24" rx="12" />
        <rect x="112" y="244" width="104" height="24" rx="12" />
        <rect x="240" y="244" width="94" height="24" rx="12" />
        <rect x="352" y="244" width="60" height="24" rx="12" />
        <rect x="6" y="298" width="120" height="30" rx="15" />
        <rect x="150" y="298" width="112" height="30" rx="15" />
        <rect x="286" y="298" width="110" height="30" rx="15" />
        <rect x="-12" y="360" width="130" height="34" rx="17" />
        <rect x="142" y="360" width="120" height="34" rx="17" />
        <rect x="286" y="360" width="120" height="34" rx="17" />
      </g>

      {/* always there: a water bowl by the gate */}
      <ellipse cx="270" cy="200" rx="15" ry="5" fill="#9cc3cc" />
      <path d="M255 200 q15 12 30 0" fill="#7aa8b4" />

      {stage >= 1 && (
        <g>
          <path d="M118 188 q-4 -26 4 -40 q8 14 4 40 Z" fill={LEAF} />
          <path d="M126 188 q4 -22 14 -30 q2 16 -8 30 Z" fill={LEAF_LIGHT} />
          <path d="M108 190 h34 l-4 20 h-26 Z" fill={POT} />
          <path d="M262 188 q-3 -22 5 -34 q7 13 3 34 Z" fill={LEAF} />
          <path d="M256 190 h28 l-3 18 h-22 Z" fill={POT} />
        </g>
      )}
      {stage >= 2 && (
        <g>
          <rect x="300" y="170" width="76" height="9" rx="4.5" fill="#a9724e" />
          <rect x="306" y="179" width="7" height="22" fill="#8c5b3d" />
          <rect x="362" y="179" width="7" height="22" fill="#8c5b3d" />
          <circle cx="24" cy="168" r="30" fill={LEAF} />
          <circle cx="46" cy="150" r="22" fill={LEAF_LIGHT} />
          <circle cx="8" cy="140" r="18" fill={LEAF} />
          <rect x="18" y="186" width="12" height="20" rx="4" fill="#8c5b3d" />
          <ellipse cx="195" cy="338" rx="72" ry="22" fill="#cfe0d2" />
        </g>
      )}
      {stage >= 3 && (
        <g>
          <path d="M0 40 Q98 82 195 54 T390 46" fill="none" stroke="#3f7a80" strokeWidth="2" />
          {[24, 78, 132, 195, 258, 312, 366].map((x, i) => (
            <circle key={x} cx={x} cy={i % 2 ? 62 + (x > 195 ? -4 : 6) : 50 + (x > 195 ? 0 : 12)} r="5.5" fill="#ffd978" />
          ))}
          <g fill="#f4a3a8">
            <circle cx="326" cy="140" r="4" />
            <circle cx="338" cy="144" r="4" />
            <circle cx="350" cy="140" r="4" />
          </g>
        </g>
      )}
    </svg>
  );
}
