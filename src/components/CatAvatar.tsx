import { useId } from "react";
import { EYE, FUR, RIBBON, RIBBON_EDGE, catDetails, type Avatar, type CatDetails, type FurKey } from "@/lib/avatar";
import { CONTACT, CONTOUR, needsContour } from "@/lib/courtyard";
import type { CareMark } from "@/lib/yard";

const EAR_LEFT = "M25.5 27 L24 11 L36.5 19.5 Z";
// A tipped ear is flat across the top.
const EAR_LEFT_TIPPED = "M25.5 27 L24.6 14.6 L29.4 15.6 L36.5 19.5 Z";
const EAR_RIGHT = "M54.5 27 L56 11 L43.5 19.5 Z";
const BODY = "M23 74 C20 56 28 44 40 44 C52 44 60 56 57 74 Z";
const TAIL = "M56 72 C70 72 72 56 66 46";
const TAIL_KINKED = "M56 72 C68 72 70 62 65 54 L71 45";
const PALE = new Set<string>(["white", "cream", "silver"]);
const SHAPE = "#12352a";

const flipOf = (d: CatDetails) => (d.flip ? "translate(80 0) scale(-1 1)" : undefined);

function Coat({ a, d }: { a: Avatar; d: CatDetails }) {
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
        <g transform={flipOf(d)}>
          <ellipse cx="28" cy="24" rx="12" ry="10" fill={base} />
          <ellipse cx="53" cy="27" rx="9" ry="8" fill={accent} />
          <ellipse cx="30" cy="58" rx="9" ry="11" fill={base} />
          <ellipse cx="52" cy="65" rx="9" ry="8" fill={accent} />
          <ellipse cx="50" cy="52" rx="4.5" ry="3.5" fill={base} />
        </g>
      );
    case "tortoiseshell":
      return (
        <g fill={accent} transform={flipOf(d)}>
          <ellipse cx="30" cy="24" rx="7" ry="5" transform="rotate(-20 30 24)" />
          <ellipse cx="50" cy="37" rx="6" ry="4.5" transform="rotate(25 50 37)" />
          <ellipse cx="28" cy="51" rx="7" ry="6" transform="rotate(15 28 51)" />
          <ellipse cx="53" cy="57" rx="8" ry="6" transform="rotate(-25 53 57)" />
          <ellipse cx="40" cy="69" rx="9" ry="5" />
          <ellipse cx="34" cy="36" rx="4" ry="3" />
          <ellipse cx="49" cy="23" rx="5" ry="4" transform="rotate(30 49 23)" />
        </g>
      );
    case "patched":
      // Mostly white, with a few dark patches that never cover the chest or the paws.
      return (
        <g fill={accent} transform={flipOf(d)}>
          {d.layout === 0 && (
            <>
              <ellipse cx="27" cy="21" rx="11" ry="8.5" transform="rotate(-18 27 21)" />
              <ellipse cx="53" cy="58" rx="8.5" ry="11" transform="rotate(12 53 58)" />
              <ellipse cx="29" cy="66" rx="5" ry="4" />
            </>
          )}
          {d.layout === 1 && (
            <>
              <ellipse cx="53" cy="22" rx="9" ry="9" />
              <ellipse cx="29" cy="55" rx="7.5" ry="10" transform="rotate(-12 29 55)" />
              <ellipse cx="50" cy="68" rx="6" ry="5" />
            </>
          )}
          {d.layout === 2 && (
            <>
              <ellipse cx="40" cy="20" rx="7" ry="6" />
              <ellipse cx="26" cy="29" rx="5" ry="6" />
              <ellipse cx="52" cy="54" rx="9" ry="8" transform="rotate(-20 52 54)" />
              <ellipse cx="30" cy="67" rx="6" ry="5" />
            </>
          )}
        </g>
      );
    case "cap":
      // A coloured cap over the crown and ears, and one small saddle patch on the back.
      return (
        <g fill={accent}>
          <path d="M8 6 H72 V27 Q62 32 54 27.5 Q47 24 40 26.5 Q33 24 26 27.5 Q18 32 8 27 Z" />
          <ellipse
            cx={d.flip ? 29 : 51}
            cy="58"
            rx="5.5"
            ry="7"
            transform={`rotate(${d.flip ? -15 : 15} ${d.flip ? 29 : 51} 58)`}
          />
        </g>
      );
    case "colourpoint":
      // Darker points: ears, a soft mask, paws and tail. Paws and tail are drawn by the avatar.
      return (
        <g fill={accent}>
          <path d={EAR_LEFT} />
          <path d={EAR_RIGHT} />
          <ellipse cx="40" cy="37" rx="10.5" ry="8.5" />
        </g>
      );
    default:
      return <ellipse cx="40" cy="38.5" rx="6.5" ry="4.6" fill={accent} opacity="0.75" />;
  }
}

/**
 * A flat, front-facing cat in the app's own soft shapes. It only ever reads fixed palette names, so no text from a
 * stored coat can reach the markup. The drawing is a look-alike; the real photo stays on the card. The ribbon is
 * a yes or no: only `ribbon === true` draws it, in one fixed colour. `ribbonPop` is for the moment she is first
 * called a girl, and plays one short scale.
 */
export function CatAvatar({
  avatar,
  id,
  marks = [],
  ribbon = false,
  ribbonPop = false,
}: {
  avatar: Avatar;
  id: string;
  marks?: CareMark[];
  ribbon?: boolean;
  ribbonPop?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clip = `av-${uid}`;
  const groundKey: FurKey = avatar.pattern === "calico" ? "white" : avatar.base;
  const ground = FUR[groundKey];
  const tipped = marks.includes("tip");
  const d = catDetails(id, avatar.pattern);
  const tailRings = avatar.pattern === "tabby";
  const pointed = avatar.pattern === "colourpoint";
  const whitePaws = avatar.pattern === "tuxedo" || avatar.pattern === "bicolour";
  const pawKey: FurKey = pointed ? avatar.accent : whitePaws ? "white" : groundKey;
  const tailKey: FurKey = pointed ? avatar.accent : groundKey;
  const pawColour = FUR[pawKey];
  const tailColour = FUR[tailKey];
  // A tail tip reads against the tail: white on a dark cat, the dark colour on a pale one.
  const tipColour = PALE.has(avatar.base) ? FUR[avatar.accent] : FUR.white;
  const tail = pointed && d.tail === "tip" ? "plain" : d.tail;
  const tailPath = tail === "kinked" ? TAIL_KINKED : TAIL;
  const blazeOk = !PALE.has(avatar.base);
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
      <ellipse cx="40" cy="75.2" rx={CONTACT.rx} ry={CONTACT.ry} fill={CONTACT.colour} opacity={CONTACT.opacity} />
      {/* A soft edge, only on a coat too close to the paving to read without one. It sits under the fur, so only its outer half shows. */}
      {(needsContour(groundKey) || needsContour(pawKey)) && (
        <g opacity={CONTOUR.opacity} fill={CONTOUR.colour} stroke={CONTOUR.colour} strokeWidth={CONTOUR.width * 2} strokeLinejoin="round">
          {needsContour(groundKey) && (
            <>
              <path d={BODY} />
              <ellipse cx="40" cy="33" rx="17" ry="14" />
              <path d={ear} />
              <path d={EAR_RIGHT} />
            </>
          )}
          {needsContour(pawKey) && (
            <>
              <ellipse cx="32" cy="74" rx="6.5" ry="3.6" />
              <ellipse cx="48" cy="74" rx="6.5" ry="3.6" />
            </>
          )}
        </g>
      )}
      <g className="avatar-tail">
        {needsContour(tailKey) && (
          <path d={tailPath} fill="none" stroke={CONTOUR.colour} strokeOpacity={CONTOUR.opacity} strokeWidth={6 + CONTOUR.width * 2} strokeLinecap="round" strokeLinejoin="round" />
        )}
        <path d={tailPath} fill="none" stroke={tailColour} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        {tailRings && tail !== "tip" && <path d={tailPath} fill="none" stroke={FUR[avatar.accent]} strokeWidth="6" strokeDasharray="2.6 5" />}
        {tail === "tip" && (
          <path d={tailPath} pathLength="100" fill="none" stroke={tipColour} strokeWidth="6" strokeLinecap="round" strokeDasharray="13 200" strokeDashoffset="-87" />
        )}
      </g>
      <g clipPath={`url(#${clip})`}>
        <rect x="10" y="8" width="60" height="70" fill={ground} />
        <Coat a={avatar} d={d} />
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
      {d.face === "blaze" && blazeOk && <path d="M40 19.5 L37.6 35.5 L42.4 35.5 Z" fill={FUR.cream} />}
      {d.face === "cheek" && <ellipse cx={d.flip ? 49.5 : 30.5} cy="39" rx="4.2" ry="3.2" fill={FUR[avatar.accent]} />}
      {ribbon === true && (
        // On the crown at the base of the left ear, tilted. It stays clear of the eyes and of the ear's inner colour.
        <g className={ribbonPop === true ? "avatar-ribbon avatar-ribbon-pop" : "avatar-ribbon"}>
          <g transform="translate(39.2 21.2) rotate(-18) scale(1.15)">
            <path d="M0 0 L-4 -2.7 Q-5.3 0 -4 2.7 Z M0 0 L4 -2.7 Q5.3 0 4 2.7 Z" fill={RIBBON} stroke={RIBBON_EDGE} strokeWidth="0.9" strokeLinejoin="round" />
            <circle r="1.7" fill={RIBBON} stroke={RIBBON_EDGE} strokeWidth="0.9" />
          </g>
        </g>
      )}
      <g className="avatar-eyes">
        <ellipse cx="33" cy="33" rx="2.5" ry="3" fill={EYE[d.eyes]} />
        <ellipse cx="47" cy="33" rx="2.5" ry="3" fill={EYE[d.eyes]} />
        <ellipse cx="33" cy="33" rx="1.1" ry="2.4" fill={SHAPE} />
        <ellipse cx="47" cy="33" rx="1.1" ry="2.4" fill={SHAPE} />
      </g>
      <path d="M38.6 37.2 h2.8 l-1.4 1.8 z" fill="#d98585" />
      <path d="M40 39 q-1.6 1.6 -3.2 .6 M40 39 q1.6 1.6 3.2 .6" fill="none" stroke="#5b4a44" strokeWidth=".8" strokeLinecap="round" />
    </svg>
  );
}
