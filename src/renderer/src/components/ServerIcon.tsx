import { useEffect, useState } from 'react'

import marketplaceIndex from '../assets/marketplace/index.json'
import atlassianLogo from '../assets/logos/atlassian.png'
import claudeLogo from '../assets/logos/claude.png'
import cursorLogo from '../assets/logos/cursor.png'
import edisonLogo from '../assets/logos/edison.png'
import githubLogo from '../assets/logos/github.png'
import mcpLogo from '../assets/logos/mcp.png'
import playwrightLogo from '../assets/logos/playwright.png'
import slackLogo from '../assets/logos/slack.png'
import supabaseLogo from '../assets/logos/supabase.png'
import windsurfLogo from '../assets/logos/windsurf.png'

interface MarketplaceIndexEntry {
  id: string
  name: string
  'icon-dark'?: string
  'icon-light'?: string
}

interface MarketplaceIndex {
  servers: MarketplaceIndexEntry[]
}

// Curated logos for first-party / well-known MCP servers. Mirrors
// SERVER_LOGOS in frontend-v2/src/shared/ui/ServerIcon.tsx - keep in sync.
const SERVER_LOGOS: Record<string, string> = {
  github: githubLogo,
  slack: slackLogo,
  supabase: supabaseLogo,
  playwright: playwrightLogo,
  atlassian: atlassianLogo,
  claude: claudeLogo,
  cursor: cursorLogo,
  edison: edisonLogo,
  trifecta: edisonLogo,
  windsurf: windsurfLogo,
  postgres: mcpLogo
}

// Eager-glob marketplace icons so Vite emits them as bundled URLs we
// can index by the relative path emitted by marketplace/index.json
// (e.g. "icons/github.png").
const marketplaceIconModules = import.meta.glob('../assets/marketplace/icons/*.{png,svg}', {
  eager: true,
  import: 'default',
  query: '?url'
}) as Record<string, string>

const marketplaceIconMap: Record<string, string> = Object.fromEntries(
  Object.entries(marketplaceIconModules).map(([path, url]) => [
    path.replace(/^.*\/marketplace\//, ''),
    url
  ])
)

const marketplaceServers: MarketplaceIndexEntry[] =
  (marketplaceIndex as MarketplaceIndex).servers ?? []

const MONOGRAM_COLORS = [
  'bg-cyan-600',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-emerald-600',
  'bg-blue-600',
  'bg-orange-600',
  'bg-pink-600'
]

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return MONOGRAM_COLORS[Math.abs(hash) % MONOGRAM_COLORS.length]
}

function monogram(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

export default function ServerIcon({
  name,
  isBuiltin = false,
  iconUrl,
  className = 'h-8 w-8'
}: {
  name: string
  isBuiltin?: boolean
  iconUrl?: string | null
  className?: string
}): React.ReactNode {
  const lower = name.toLowerCase()
  const segments = lower.split(/[-_]/)
  const [imgError, setImgError] = useState(false)

  const hardcodedLogo = isBuiltin
    ? edisonLogo
    : Object.entries(SERVER_LOGOS).find(([key]) => segments.includes(key))?.[1]

  const marketplaceEntry = !hardcodedLogo
    ? marketplaceServers.find((s) => {
        const mLower = s.name.toLowerCase()
        const mSegments = mLower.split(/[-_.]/)
        return (
          mLower === lower ||
          segments.includes(mLower) ||
          mSegments.every((seg) => segments.includes(seg))
        )
      })
    : undefined

  // The Electron renderer is dark-themed, so prefer icon-dark and
  // fall back to icon-light.
  const marketplaceIconPath = marketplaceEntry
    ? (marketplaceEntry['icon-dark'] ?? marketplaceEntry['icon-light'])
    : undefined

  const marketplaceIcon = marketplaceIconPath ? marketplaceIconMap[marketplaceIconPath] : undefined

  // Resolution order matches frontend-v2 ServerIcon: curated hardcoded
  // asset -> marketplace icon -> per-server icon URL (logo.dev) ->
  // monogram fallback.
  const logo = hardcodedLogo ?? marketplaceIcon ?? (iconUrl || undefined)

  useEffect(() => {
    setImgError(false)
  }, [logo])

  if (logo && !imgError) {
    return (
      <img
        src={logo}
        alt={name}
        className={`${className} shrink-0 rounded object-contain`}
        onError={() => setImgError(true)}
      />
    )
  }

  const bgClass = isBuiltin
    ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
    : `${hashColor(name)} text-white`

  return (
    <span
      className={`${className} inline-flex shrink-0 items-center justify-center rounded text-[10px] font-bold leading-none ${bgClass}`}
      title={name}
    >
      {monogram(name)}
    </span>
  )
}
