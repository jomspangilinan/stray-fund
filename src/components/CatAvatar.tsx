import { useId } from "react";
import { FUR, type Avatar } from "@/lib/avatar";
import type { CareMark } from "@/lib/yard";

const EAR_LEFT = "M25.5 27 L24 11 L36.5 19.5 Z";
// A tipped ear is flat across the top.
const EAR_LEFT_TIPPED = "M25.5 27 L24.6 14.6 L29.4 15.6 L36.5 19.5 Z";
const EAR_RIGHT = "M54.5 27 L56 11 L43.5 19.5 Z";
const BODY = "M23 74 C20 56 28 44 40 44 C52 44 60 56 57 74 Z";
const TAIL = "M56 72 C70 72 72 56 66 46";
const SHAPE = "#12352a";

function Coat({ a }: { a: Avatar }) {
  const base = FUR[a.base];
  const accent = FUR[a.accent];
  switch (a.pattern) {
    case "tabby":
      return (
        <g fill="none" stroke={accent} strokeLinecap="round">
          <path d="M40 19.5 v6 M35 20.8 l1.2 5 M45 20.8 l-1.2 5" strokeWidth="1.8" />
          <path d="M24 33 h5 M24.6 36.5 l4.6 -.8 M56 33 h-5 M55.4 36.5 l-4.6 -.8" strokeWidth="1.6" />
          <path d="M25 55 h7 M24.5 61 h7.5 M24 67 h8 M55 55 h-7 M55.5 61 h-7.5 M56 67 h-8" strokeWidth="2.2" />
        </g>
      );
    case "tuxedo":
      return (
        <g fill={accent}>
          <ellipse cx="40" cy="60" rx="8" ry="15" />
          <path d="M40 23 L36.5 38 L43.5 38 Z" />
          <ellipse cx="40" cy="38.5" rx="7" ry="5.2" />
          <ellipse cx="32" cy="74" rx="6.5" ry="3.6" />
          <ellipse cx="48" cy="74" rx="6.5" ry="3.6" />
        </g>
      );
    case "bicolour":
      return (
        <g fill={accent}>
          <ellipse cx="40" cy="68" rx="18" ry="19" />
          <path d="M40 21 L34 38 L46 38 Z" />
          <ellipse cx="40" cy="38.5" rx="9" ry="6" />
          <ellipse cx="32" cy="74" rx="6.5" ry="3.6" />
          <ellipse cx="48" cy="74" rx="6.5" ry="3.6" />
        </g>
      );
    case "calico":
      return (
        <g>
          <ellipse cx="28" cy="24" rx="12" ry="10" fill={base} />
          <ellipse cx="53" cy="27" rx="9" ry="8" fill={accent} />
          <ellipse cx="30" cy="58" rx="9" ry="11" fill={base} />
          <ellipse cx="52" cy="65" rx="9" ry="8" fill={accent} />
          <ellipse cx="50" cy="52" rx="4.5" ry="3.5" fill={base} />
        </g>
      );
    case "tortoiseshell":
      return (
        <g fill={accent}>
          <ellipse cx="30" cy="24" rx="7" ry="5" transform="rotate(-20 30 24)" />
          <ellipse cx="50" cy="37" rx="6" ry="4.5" transform="rotate(25 50 37)" />
          <ellipse cx="28" cy="51" rx="7" ry="6" transform="rotate(15 28 51)" />
          <ellipse cx="53" cy="57" rx="8" ry="6" transform="rotate(-25 53 57)" />
          <ellipse cx="40" cy="69" rx="9" ry="5" />
          <ellipse cx="34" cy="36" rx="4" ry="3" />
          <ellipse cx="49" cy="23" rx="5" ry="4" transform="rotate(30 49 23)" />
        </g>
      );
    default:
      return <ellipse cx="40" cy="38.5" rx="6.5" ry="4.6" fill={accent} opacity="0.75" />;
  }
}

/**
 * A flat, front-facing cat in the app's own soft shapes. It only ever reads fixed palette names, so no text from a
 * stored coat can reach the markup. The drawing is a look-alike; the real photo stays on the card.
 */
export function CatAvatar({ avatar, marks = [] }: { avatar: Avatar; marks?: CareMark[] }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clip = `av-${uid}`;
  const ground = avatar.pattern === "calico" ? FUR.white : FUR[avatar.base];
  const tipped = marks.includes("tip");
  const tailRings = avatar.pattern === "tabby";
  const pawColour = avatar.pattern === "tuxedo" || avatar.pattern === "bicolour" ? FUR.white : ground;
  const ear = tipped ? EAR_LEFT_TIPPED : EAR_LEFT;
  return (
    <svg viewBox="0 0 80 80" className="avatar" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <path d={BODY} />
          <ellipse cx="40" cy="33" rx="17" ry="14" />
          <path d={ear} />
          <path d={EAR_RIGHT} />
        </clipPath>
      </defs>
      <ellipse cx="40" cy="75.5" rx="25" ry="4" fill={SHAPE} opacity="0.14" />
      <g className="avatar-tail">
        <path d={TAIL} fill="none" stroke={ground} strokeWidth="6" strokeLinecap="round" />
        {tailRings && <path d={TAIL} fill="none" stroke={FUR[avatar.accent]} strokeWidth="6" strokeDasharray="2.6 5" />}
      </g>
      <g clipPath={`url(#${clip})`}>
        <rect x="10" y="8" width="60" height="70" fill={ground} />
        <Coat a={avatar} />
        <ellipse cx="40" cy="82" rx="26" ry="14" fill={SHAPE} opacity="0.1" />
      </g>
      <path d="M27.6 25.5 L26.4 15.5 L33.4 20.4 Z" fill="#e7a3a0" opacity="0.8" />
      <path d="M52.4 25.5 L53.6 15.5 L46.6 20.4 Z" fill="#e7a3a0" opacity="0.8" />
      <ellipse cx="32" cy="74" rx="6.5" ry="3.6" fill={pawColour} />
      <ellipse cx="48" cy="74" rx="6.5" ry="3.6" fill={pawColour} />
      {marks.includes("collar") && (
        <g>
          <path d="M29 43 Q40 49.5 51 43 L51 46.6 Q40 53 29 46.6 Z" fill="#df6f69" />
          <circle cx="40" cy="50.6" r="2.1" fill="#f2c54f" />
        </g>
      )}
      <g className="avatar-eyes" fill={SHAPE}>
        <ellipse cx="33" cy="33" rx="1.8" ry="2.4" />
        <ellipse cx="47" cy="33" rx="1.8" ry="2.4" />
      </g>
      <path d="M38.6 37.2 h2.8 l-1.4 1.8 z" fill="#d98585" />
      <path d="M40 39 q-1.6 1.6 -3.2 .6 M40 39 q1.6 1.6 3.2 .6" fill="none" stroke="#5b4a44" strokeWidth=".8" strokeLinecap="round" />
    </svg>
  );
}
