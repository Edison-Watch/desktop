/**
 * Two-phase animation for the Secure Your Setup step.
 *
 * Phase 1: Laptop (Claude + 3 MCPs) connects directly to 3 MCP servers.
 * Transition: Edison Watch fades in as a gateway.
 * Phase 2: All connections now route through Edison (packets change
 *          from orange to accent as they pass through).
 *
 * 10s loop. Pure SVG + CSS. Respects `prefers-reduced-motion`.
 */
import { AGENT_REGISTRY } from '@edison/shared/agent-registry'

const CLAUDE_SPRITE = AGENT_REGISTRY['claude-code']
const CURSOR_SPRITE = AGENT_REGISTRY['cursor']
const VSCODE_SPRITE = AGENT_REGISTRY['vscode']
const O = '#da7756'

const MCP_D1 =
  'M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z'
const MCP_D2 =
  'M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z'

const CSS = `
.ew-anim { color: var(--text-primary); }

/* dashed-line flow */
.ew-anim .ew-line { stroke-dashoffset:0; animation: ew-lf 2s linear infinite; }

/* packet fill inherits currentColor */
.ew-anim .ew-pkt path, .ew-anim .ew-pkt circle { fill: currentColor; }

/* ── phase visibility (10s cycle) ── */
.ew-anim .ew-direct { animation: ew-dv 10s ease-in-out infinite; }
.ew-anim .ew-edison { animation: ew-ev 10s ease-in-out infinite; transform-origin: 257px 93px; }
.ew-anim .ew-routed { animation: ew-rv 10s ease-in-out infinite; }
.ew-anim .ew-local-wrap { animation: ew-rv 10s ease-in-out infinite; }

/* ── 3 packets (each has direct + routed phases) ── */
.ew-anim .ew-pkt-main { color:${O}; animation: ew-pkt-main 10s ease-in-out infinite; }

/* ── Edison pulse ── */
.ew-anim .ew-pulse { transform-origin:257px 93px; animation: ew-pulse 1.33s cubic-bezier(.2,.8,.4,1) infinite; }

/* ───── keyframes ───── */
@keyframes ew-lf { to { stroke-dashoffset: -12; } }

/* Phase visibility */
@keyframes ew-dv {
  0%,26%  { opacity:1; }
  34%     { opacity:0; }
  100%    { opacity:0; }
}
@keyframes ew-ev {
  0%,28%  { opacity:0; transform:scale(.85); }
  36%     { opacity:1; transform:scale(1); }
  100%    { opacity:1; transform:scale(1); }
}
@keyframes ew-rv {
  0%,28%  { opacity:0; }
  36%     { opacity:1; }
  100%    { opacity:1; }
}

/* Single packet: request-response, one server at a time */
@keyframes ew-pkt-main {
  /* ── Phase 1: direct request to middle server ── */
  0%,1%  { opacity:0; }
  2%     { transform:translate(176px,93px); opacity:0;  color:${O}; }
  3%     { transform:translate(176px,93px); opacity:.8; color:${O}; }
  12%    { transform:translate(426px,93px); opacity:1;  color:${O}; }
  13%    { transform:translate(426px,93px); opacity:.6; color:${O}; }
  /* ── Phase 1: direct response from middle server ── */
  14%    { transform:translate(426px,93px); opacity:.8; color:${O}; }
  23%    { transform:translate(176px,93px); opacity:1;  color:${O}; }
  24%    { transform:translate(176px,93px); opacity:0; }
  25%,37%{ opacity:0; }
  /* ── Phase 2: routed request through Edison to middle server ── */
  38%    { transform:translate(100px,93px); opacity:0;  color:${O}; }
  39%    { transform:translate(100px,93px); opacity:.8; color:${O}; }
  45%    { transform:translate(251px,93px); opacity:1;  color:${O}; }
  47%    { transform:translate(257px,93px); opacity:.3; color:var(--accent); }
  49%    { transform:translate(263px,93px); opacity:1;  color:var(--accent); }
  57%    { transform:translate(426px,93px); opacity:1;  color:var(--accent); }
  58%    { transform:translate(426px,93px); opacity:.6; color:var(--accent); }
  /* ── Phase 2: routed response back through Edison ── */
  59%    { transform:translate(426px,93px); opacity:.8; color:var(--accent); }
  67%    { transform:translate(263px,93px); opacity:1;  color:var(--accent); }
  69%    { transform:translate(257px,93px); opacity:.3; color:var(--accent); }
  71%    { transform:translate(251px,93px); opacity:1;  color:var(--accent); }
  78%    { transform:translate(100px,93px); opacity:1;  color:var(--accent); }
  79%    { transform:translate(100px,93px); opacity:0; }
  80%,100%{ opacity:0; }
}

@keyframes ew-pulse {
  0%  { transform:scale(1);   opacity:0; }
  10% { transform:scale(1);   opacity:.4; }
  60% { transform:scale(1.6); opacity:0; }
  100%{ transform:scale(1.6); opacity:0; }
}

/* progress bar */
.ew-anim .ew-progress { transform-origin:20px 188px; animation: ew-prog 10s linear infinite; }
@keyframes ew-prog {
  0%   { transform:scaleX(0); }
  100% { transform:scaleX(1); }
}

@media (prefers-reduced-motion:reduce) {
  .ew-anim .ew-line, .ew-anim .ew-pkt-main,
  .ew-anim .ew-pulse, .ew-anim .ew-direct, .ew-anim .ew-edison,
  .ew-anim .ew-routed { animation:none; }
  .ew-anim .ew-pkt-main { opacity:0; }
  .ew-anim .ew-progress { animation:none; transform:scaleX(1); }
  .ew-anim .ew-edison { opacity:1; transform:scale(1); }
  .ew-anim .ew-direct { opacity:0; }
  .ew-anim .ew-routed { opacity:1; }
  .ew-anim .ew-local-wrap { animation:none; opacity:1; }
}
`

function McpIcon({ x, y, size, color, opacity = '0.65' }: {
  x: number; y: number; size: number; color: string; opacity?: string
}): React.ReactNode {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 24 24">
      <path d={MCP_D1} fill={color} fillOpacity={opacity} />
      <path d={MCP_D2} fill={color} fillOpacity={opacity} />
    </svg>
  )
}

function McpServer({ x, y }: { x: number; y: number }): React.ReactNode {
  return (
    <g>
      <rect
        x={x} y={y} width="56" height="48" rx="6"
        fill="var(--text-primary)" fillOpacity="0.03"
        stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1"
      />
      <McpIcon x={x + 16} y={y + 6} size={24} color="var(--text-muted)" opacity="0.6" />
      <circle cx={x + 28} cy={y + 38} r="1.5" fill="var(--text-muted)" fillOpacity="0.35" />
      <line
        x1={x + 34} y1={y + 38} x2={x + 48} y2={y + 38}
        stroke="var(--text-muted)" strokeOpacity="0.15" strokeWidth="1" strokeDasharray="2 2"
      />
    </g>
  )
}

function Packet(): React.ReactNode {
  return (
    <>
      <circle r="10" fillOpacity="0.12" />
      <g transform="translate(-6,-6) scale(0.5)">
        <path d={MCP_D1} />
        <path d={MCP_D2} />
      </g>
    </>
  )
}

export default function EncryptionAnimation(): React.ReactNode {
  return (
    <div className="flex justify-center">
      <style>{CSS}</style>
      <svg
        className="ew-anim"
        width={500}
        height={190}
        viewBox="0 0 500 190"
        xmlns="http://www.w3.org/2000/svg"
        role="presentation"
        aria-hidden="true"
      >
        {/* ══ Phase 1: direct connector lines (laptop → servers) ══ */}
        <g className="ew-direct">
          <line className="ew-line" x1="176" y1="93" x2="394" y2="38"
            stroke="var(--text-muted)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
          <line className="ew-line" x1="176" y1="93" x2="394" y2="93"
            stroke="var(--text-muted)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
          <line className="ew-line" x1="176" y1="93" x2="394" y2="148"
            stroke="var(--text-muted)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
        </g>

        {/* ══ Edison gateway (fades in for phase 2) ══ */}
        <g className="ew-edison">
          <circle className="ew-pulse" cx="257" cy="93" r="30"
            fill="none" stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="1.5" />
          <svg x="230" y="67" width="54" height="52.5" viewBox="0 0 188 183">
            <path d="M110.597 147.7V139.729C110.597 139.481 110.792 139.286 111.04 139.286H119.028C119.276 139.286 119.472 139.091 119.472 138.843V130.871C119.472 130.623 119.667 130.429 119.915 130.429H127.903C128.151 130.429 128.347 130.234 128.347 129.986V113.157C128.347 112.909 128.542 112.714 128.79 112.714H136.778C137.026 112.714 137.222 112.909 137.222 113.157V129.986C137.222 130.234 137.026 130.429 136.778 130.429H128.79C128.542 130.429 128.347 130.623 128.347 130.871V147.7C128.347 147.948 128.151 148.143 127.903 148.143H119.915C119.667 148.143 119.472 148.338 119.472 148.586V156.557C119.472 156.805 119.276 157 119.028 157H22.2992C22.0507 157 21.8555 156.805 21.8555 156.557V148.586C21.8555 148.338 22.0507 148.143 22.2992 148.143H39.1617C39.4102 148.143 39.6055 147.948 39.6055 147.7V130.871C39.6055 130.623 39.8007 130.429 40.0492 130.429H48.0367C48.2852 130.429 48.4805 130.234 48.4805 129.986V113.157C48.4805 112.909 48.6757 112.714 48.9242 112.714H56.9117C57.1602 112.714 57.3555 112.519 57.3555 112.271V86.5857C57.3555 86.3377 57.5507 86.1429 57.7992 86.1429H65.7867C66.0352 86.1429 66.2305 85.948 66.2305 85.7V68.8714C66.2305 68.6234 66.4257 68.4286 66.6742 68.4286H74.6617C74.9102 68.4286 75.1055 68.2337 75.1055 67.9857V42.3C75.1055 42.052 74.9102 41.8571 74.6617 41.8571H66.6742C66.4257 41.8571 66.2305 41.6623 66.2305 41.4143V33.4429C66.2305 33.1949 66.4257 33 66.6742 33H163.412C163.66 33 163.855 33.1949 163.855 33.4429V50.2714C163.855 50.5194 163.66 50.7143 163.412 50.7143H155.424C155.176 50.7143 154.98 50.9091 154.98 51.1571V76.8429C154.98 77.0909 154.785 77.2857 154.537 77.2857H146.549C146.301 77.2857 146.105 77.0909 146.105 76.8429V42.3C146.105 42.052 145.91 41.8571 145.662 41.8571H93.2992C93.0507 41.8571 92.8555 42.052 92.8555 42.3V67.9857C92.8555 68.2337 92.6602 68.4286 92.4117 68.4286H84.4242C84.1757 68.4286 83.9805 68.6234 83.9805 68.8714V85.7C83.9805 85.948 84.1757 86.1429 84.4242 86.1429H110.162C110.41 86.1429 110.605 85.948 110.605 85.7V77.7286C110.605 77.4806 110.801 77.2857 111.049 77.2857H119.037C119.285 77.2857 119.48 77.0909 119.48 76.8429V68.8714C119.48 68.6234 119.676 68.4286 119.924 68.4286H127.912C128.16 68.4286 128.355 68.6234 128.355 68.8714V76.8429C128.355 77.0909 128.16 77.2857 127.912 77.2857H119.924C119.676 77.2857 119.48 77.4806 119.48 77.7286V94.5571C119.48 94.8051 119.285 95 119.037 95H111.049C110.801 95 110.605 95.1949 110.605 95.4429V112.271C110.605 112.519 110.41 112.714 110.162 112.714H102.174C101.926 112.714 101.73 112.519 101.73 112.271V95.4429C101.73 95.1949 101.535 95 101.287 95H75.5492C75.3007 95 75.1055 95.1949 75.1055 95.4429V112.271C75.1055 112.519 74.9102 112.714 74.6617 112.714H66.6742C66.4257 112.714 66.2305 112.909 66.2305 113.157V129.986C66.2305 130.234 66.0352 130.429 65.7867 130.429H57.7992C57.5507 130.429 57.3555 130.623 57.3555 130.871V147.7C57.3555 147.948 57.5507 148.143 57.7992 148.143H110.162C110.41 148.143 110.605 147.948 110.605 147.7H110.597Z"
              fill="var(--accent)" fillOpacity="0.8" stroke="var(--accent)" strokeWidth="5" strokeMiterlimit="10" />
            <path d="M159.046 132.884L168.082 132.972C168.112 147.126 168.078 141.215 168.078 158L144.226 157.862C144.018 157.862 143.855 157.679 143.855 157.445V149.952C143.855 149.719 144.018 149.536 144.226 149.536H158.305C158.512 149.536 158.675 149.353 158.675 149.12V133.301C158.675 133.067 158.838 132.884 159.046 132.884Z"
              fill="var(--accent)" fillOpacity="0.8" />
            <path d="M168.078 131C168.115 147.685 168.078 140.482 168.078 158L144.226 157.862C144.018 157.862 143.855 157.679 143.855 157.445V149.952C143.855 149.719 144.018 149.536 144.226 149.536H158.305C158.512 149.536 158.675 149.353 158.675 149.12V133.301C158.675 133.067 158.838 132.884 159.046 132.884L169.855 132.99"
              stroke="var(--accent)" strokeOpacity="0.8" strokeWidth="4" strokeMiterlimit="10" />
            <path d="M187.855 179C187.855 181.209 186.065 183 183.855 183H4C1.79086 183 0 181.209 0 179L0 4C0 1.79086 1.79086 0 4 0L183.855 0C186.065 0 187.855 1.79086 187.855 4V179ZM61.8555 19C61.8555 21.2091 60.0646 23 57.8555 23H12C9.79086 23 8 24.7909 8 27V171C8 173.209 9.79086 175 12 175H175.855C178.065 175 179.855 173.209 179.855 171V12C179.855 9.79086 178.065 8 175.855 8H65.8555C63.6463 8 61.8555 9.79086 61.8555 12V19Z"
              fill="var(--accent)" fillOpacity="0.8" />
          </svg>
        </g>

        {/* ══ Phase 2: routed connector lines (laptop → Edison → servers) ══ */}
        <g className="ew-routed">
          <line className="ew-line" x1="176" y1="93" x2="226" y2="93"
            stroke="var(--text-muted)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
          <line className="ew-line" x1="288" y1="93" x2="394" y2="38"
            stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
          <line className="ew-line" x1="288" y1="93" x2="394" y2="93"
            stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
          <line className="ew-line" x1="288" y1="93" x2="394" y2="148"
            stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 3" />
        </g>

        {/* ══ Laptop (always visible) ══ */}
        <rect x="4" y="23" width="168" height="96" rx="7"
          fill="var(--text-primary)" fillOpacity="0.03"
          stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1.5" />
        <rect x="0" y="121" width="176" height="8" rx="4"
          fill="var(--text-primary)" fillOpacity="0.04"
          stroke="var(--text-muted)" strokeOpacity="0.35" strokeWidth="1" />

        {/* AI agent icons (row inside laptop) */}
        <rect x="41" y="35" width="30" height="30" rx="7" fill={CURSOR_SPRITE.brandColor} />
        <svg x="45" y="39" width="22" height="22" viewBox="0 0 24 24">
          <path d={CURSOR_SPRITE.svgPath} fill="#fff" />
        </svg>
        <rect x="73" y="35" width="30" height="30" rx="7" fill={CLAUDE_SPRITE.brandColor} />
        <svg x="77" y="39" width="22" height="22" viewBox="0 -20 90 90"
          shapeRendering="crispEdges"
          dangerouslySetInnerHTML={{ __html: CLAUDE_SPRITE.customSvg ?? '' }} />
        <rect x="105" y="35" width="30" height="30" rx="7" fill={VSCODE_SPRITE.brandColor} />
        <svg x="109" y="39" width="22" height="22" viewBox="0 0 24 24">
          <path d={VSCODE_SPRITE.svgPath} fill="#fff" />
        </svg>

        {/* 3 MCP icons (row below Claude inside laptop) */}
        {[38, 74, 110].map((mx) => (
          <g key={mx}>
            <rect x={mx} y="79" width="28" height="28" rx="6"
              fill="var(--text-primary)" fillOpacity="0.04"
              stroke="var(--text-muted)" strokeOpacity="0.3" strokeWidth="1" />
            <McpIcon x={mx + 2} y={81} size={24} color="var(--text-primary)" />
          </g>
        ))}

        {/* ══ Local Edison wrapper around MCPs (fades in with Edison) ══ */}
        <g className="ew-local-wrap">
          <rect
            x="30"
            y="73"
            width="118"
            height="40"
            rx="6"
            fill="var(--accent)"
            fillOpacity="0.03"
            stroke="var(--accent)"
            strokeOpacity="0.5"
            strokeWidth="1.5"
          />
          {/* Edison logo badge at top-left */}
          <svg x="14" y="62" width="20" height="19.5" viewBox="0 0 188 183">
            <path
              d="M110.597 147.7V139.729C110.597 139.481 110.792 139.286 111.04 139.286H119.028C119.276 139.286 119.472 139.091 119.472 138.843V130.871C119.472 130.623 119.667 130.429 119.915 130.429H127.903C128.151 130.429 128.347 130.234 128.347 129.986V113.157C128.347 112.909 128.542 112.714 128.79 112.714H136.778C137.026 112.714 137.222 112.909 137.222 113.157V129.986C137.222 130.234 137.026 130.429 136.778 130.429H128.79C128.542 130.429 128.347 130.623 128.347 130.871V147.7C128.347 147.948 128.151 148.143 127.903 148.143H119.915C119.667 148.143 119.472 148.338 119.472 148.586V156.557C119.472 156.805 119.276 157 119.028 157H22.2992C22.0507 157 21.8555 156.805 21.8555 156.557V148.586C21.8555 148.338 22.0507 148.143 22.2992 148.143H39.1617C39.4102 148.143 39.6055 147.948 39.6055 147.7V130.871C39.6055 130.623 39.8007 130.429 40.0492 130.429H48.0367C48.2852 130.429 48.4805 130.234 48.4805 129.986V113.157C48.4805 112.909 48.6757 112.714 48.9242 112.714H56.9117C57.1602 112.714 57.3555 112.519 57.3555 112.271V86.5857C57.3555 86.3377 57.5507 86.1429 57.7992 86.1429H65.7867C66.0352 86.1429 66.2305 85.948 66.2305 85.7V68.8714C66.2305 68.6234 66.4257 68.4286 66.6742 68.4286H74.6617C74.9102 68.4286 75.1055 68.2337 75.1055 67.9857V42.3C75.1055 42.052 74.9102 41.8571 74.6617 41.8571H66.6742C66.4257 41.8571 66.2305 41.6623 66.2305 41.4143V33.4429C66.2305 33.1949 66.4257 33 66.6742 33H163.412C163.66 33 163.855 33.1949 163.855 33.4429V50.2714C163.855 50.5194 163.66 50.7143 163.412 50.7143H155.424C155.176 50.7143 154.98 50.9091 154.98 51.1571V76.8429C154.98 77.0909 154.785 77.2857 154.537 77.2857H146.549C146.301 77.2857 146.105 77.0909 146.105 76.8429V42.3C146.105 42.052 145.91 41.8571 145.662 41.8571H93.2992C93.0507 41.8571 92.8555 42.052 92.8555 42.3V67.9857C92.8555 68.2337 92.6602 68.4286 92.4117 68.4286H84.4242C84.1757 68.4286 83.9805 68.6234 83.9805 68.8714V85.7C83.9805 85.948 84.1757 86.1429 84.4242 86.1429H110.162C110.41 86.1429 110.605 85.948 110.605 85.7V77.7286C110.605 77.4806 110.801 77.2857 111.049 77.2857H119.037C119.285 77.2857 119.48 77.0909 119.48 76.8429V68.8714C119.48 68.6234 119.676 68.4286 119.924 68.4286H127.912C128.16 68.4286 128.355 68.6234 128.355 68.8714V76.8429C128.355 77.0909 128.16 77.2857 127.912 77.2857H119.924C119.676 77.2857 119.48 77.4806 119.48 77.7286V94.5571C119.48 94.8051 119.285 95 119.037 95H111.049C110.801 95 110.605 95.1949 110.605 95.4429V112.271C110.605 112.519 110.41 112.714 110.162 112.714H102.174C101.926 112.714 101.73 112.519 101.73 112.271V95.4429C101.73 95.1949 101.535 95 101.287 95H75.5492C75.3007 95 75.1055 95.1949 75.1055 95.4429V112.271C75.1055 112.519 74.9102 112.714 74.6617 112.714H66.6742C66.4257 112.714 66.2305 112.909 66.2305 113.157V129.986C66.2305 130.234 66.0352 130.429 65.7867 130.429H57.7992C57.5507 130.429 57.3555 130.623 57.3555 130.871V147.7C57.3555 147.948 57.5507 148.143 57.7992 148.143H110.162C110.41 148.143 110.605 147.948 110.605 147.7H110.597Z"
              fill="var(--accent)" fillOpacity="0.8" stroke="var(--accent)" strokeWidth="5" strokeMiterlimit="10"
            />
            <path
              d="M159.046 132.884L168.082 132.972C168.112 147.126 168.078 141.215 168.078 158L144.226 157.862C144.018 157.862 143.855 157.679 143.855 157.445V149.952C143.855 149.719 144.018 149.536 144.226 149.536H158.305C158.512 149.536 158.675 149.353 158.675 149.12V133.301C158.675 133.067 158.838 132.884 159.046 132.884Z"
              fill="var(--accent)" fillOpacity="0.8"
            />
            <path
              d="M168.078 131C168.115 147.685 168.078 140.482 168.078 158L144.226 157.862C144.018 157.862 143.855 157.679 143.855 157.445V149.952C143.855 149.719 144.018 149.536 144.226 149.536H158.305C158.512 149.536 158.675 149.353 158.675 149.12V133.301C158.675 133.067 158.838 132.884 159.046 132.884L169.855 132.99"
              stroke="var(--accent)" strokeOpacity="0.8" strokeWidth="4" strokeMiterlimit="10"
            />
            <path
              d="M187.855 179C187.855 181.209 186.065 183 183.855 183H4C1.79086 183 0 181.209 0 179L0 4C0 1.79086 1.79086 0 4 0L183.855 0C186.065 0 187.855 1.79086 187.855 4V179ZM61.8555 19C61.8555 21.2091 60.0646 23 57.8555 23H12C9.79086 23 8 24.7909 8 27V171C8 173.209 9.79086 175 12 175H175.855C178.065 175 179.855 173.209 179.855 171V12C179.855 9.79086 178.065 8 175.855 8H65.8555C63.6463 8 61.8555 9.79086 61.8555 12V19Z"
              fill="var(--accent)" fillOpacity="0.8"
            />
          </svg>
        </g>

        {/* ══ 3 MCP servers (always visible) ══ */}
        <McpServer x={398} y={14} />
        <McpServer x={398} y={69} />
        <McpServer x={398} y={124} />

        {/* ══ Labels ══ */}
        <text x="88" y="145" textAnchor="middle"
          fill="var(--text-primary)" fontSize="9" fontWeight="bold" fontFamily="system-ui,sans-serif">
          Local
        </text>
        <g className="ew-edison">
          <text x="257" y="135" textAnchor="middle"
            fill="var(--text-primary)" fontSize="9" fontWeight="bold" fontFamily="system-ui,sans-serif">
            Edison Gateway
          </text>
        </g>
        <text x="426" y="184" textAnchor="middle"
          fill="var(--text-primary)" fontSize="9" fontWeight="bold" fontFamily="system-ui,sans-serif">
          MCP Servers
        </text>

        {/* ══ 3 Packets (each animates direct → hidden → routed) ══ */}
        <g className="ew-pkt ew-pkt-main"><Packet /></g>

        {/* ══ Progress bar ══ */}
        <rect x="20" y="188" width="460" height="1.5" rx="0.75"
          fill="var(--text-primary)" fillOpacity="0.1" />
        <rect className="ew-progress" x="20" y="188" width="460" height="1.5" rx="0.75"
          fill="var(--text-primary)" fillOpacity="0.35" />
      </svg>
    </div>
  )
}
