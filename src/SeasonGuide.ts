/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Season Guide: every anime of a season in one place, sorted by how well it
// matches your taste, with a top-10 tier list of the season, your list status
// and whether AniLiberty dubs it.
//
// Season data and your taste profile come from AniList (through Seanime's
// client, with your token); the dub list comes from the AniLiberty API.

interface SeasonItem {
  id: number
  idMal: number
  title: string
  cover: string
  coverLarge: string
  banner: string
  color: string
  format: string
  episodes: number
  duration: number
  status: string
  start: number[]          // [year, month, day], zeros if unknown
  genres: string[]
  studios: string[]
  tags: string[]
  score: number            // AniList average score 0-100, 0 if none yet
  votes: number
  popularity: number
  trending: number
  nextEpisode: number      // 0 if not airing
  nextAiringAt: number     // unix seconds, 0 if not airing
}

function init() {
  // Seanime runs the UI handler in its own runtime, from its source text, so
  // it can't see anything declared at the top level of this file. Everything
  // it needs comes from the shared module compiled from createSeasonGuide().
  $shared.define("season-guide", createSeasonGuide)

  $ui.register((ctx) => {
    const G = $shared.use("season-guide")

    const page = ctx.newWebview({
      slot: "screen",
      fullWidth: true,
      autoHeight: true,
      sidebar: { label: "Season Guide", icon: G.ICON },
    })

    const payload = ctx.state<any>(null)
    page.channel.sync("data", payload)
    page.setContent(() => G.PAGE_HTML)

    let current = G.currentSeason(Date.now())

    async function load(year: number, season: string, force: boolean) {
      current = { year, season }
      // A season opened before shows up at once from the cache, even if it's
      // due for a refresh; the fresh data replaces it when it arrives.
      const cached = force ? null : G.cachedPayload(year, season)
      if (cached) payload.set(Object.assign(cached, { loading: !cached.fresh }))
      else payload.set(Object.assign({}, payload.get() || {}, { loading: true, year, season, items: null, tiers: [] }))

      if (!cached || !cached.fresh) {
        const result = await G.loadSeason(year, season, force)
        // Ignore a slow answer for a season the user has already left.
        if (current.year !== year || current.season !== season) return
        payload.set(result)
      }
      // The neighbouring seasons load in the background, so switching to
      // them is instant.
      G.prefetchAround(year, season)
    }

    page.channel.on("load-season", (p: any) => {
      if (p && p.year && p.season) load(Number(p.year), String(p.season), false)
    })
    page.channel.on("refresh", () => {
      load(current.year, current.season, true)
    })
    page.channel.on("open", (p: any) => {
      const id = p && Number(p.id)
      if (id) ctx.screen.navigateTo("/entry", { id: String(id) })
    })
    page.channel.on("plan", (p: any) => {
      const id = p && Number(p.id)
      if (!id) return
      const library = G.addToPlanning(id)
      if (library) payload.set(Object.assign({}, payload.get() || {}, { library }))
    })
    page.channel.on("set-prefs", (p: any) => {
      payload.set(Object.assign({}, payload.get() || {}, { prefs: G.savePrefs(p) }))
    })

    load(current.year, current.season, false)
    page.onMount(() => load(current.year, current.season, false))
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, fetch, ...).
// Keep it free of anything esbuild compiles into top-level helpers (tagged
// templates like String.raw, for one): those would be outside this function.
function createSeasonGuide() {
  const PREFS_KEY = "sg-prefs"
  const TASTE_KEY = "sg-taste-v1"
  const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"]
  const ANILIBERTY_SEASON: { [s: string]: string } = { WINTER: "winter", SPRING: "spring", SUMMER: "summer", FALL: "autumn" }
  const SEASON_START_MONTH: { [s: string]: number } = { WINTER: 0, SPRING: 3, SUMMER: 6, FALL: 9 }
  // Formats that take part in the tier list (no shorts, specials or music videos).
  const TIER_FORMATS: { [f: string]: boolean } = { TV: true, ONA: true, MOVIE: true, OVA: true }
  // Pyramid: S has the best show of the season, then 2, 3 and 4.
  const TIER_SIZES: [string, number][] = [["S", 1], ["A", 2], ["B", 3], ["C", 4]]
  // Until this long after a season starts, few people have rated it yet.
  const EARLY_DAYS = 42
  const MAX_PAGES = 6
  const MAX_CACHED_SEASONS = 12

  const ICON = `<span style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:currentColor"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.95 15.95a6 6 0 1 0-7.9 0"/><path d="M4 20h16"/><path d="M7 16h10"/></svg></span>`

  const SEASON_QUERY = `query ($season: MediaSeason, $year: Int, $p: Int) {
    Page(page: $p, perPage: 50) {
      pageInfo { hasNextPage }
      media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
        id idMal format episodes duration status
        title { userPreferred }
        coverImage { large medium color }
        bannerImage
        startDate { year month day }
        genres averageScore popularity trending
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { episode airingAt }
        tags { name rank }
        stats { scoreDistribution { amount } }
      }
    }
  }`

  const TASTE_QUERY = `query ($u: Int) {
    MediaListCollection(userId: $u, type: ANIME) {
      lists { entries {
        status score(format: POINT_100)
        media { id genres studios(isMain: true) { nodes { name } } tags { name rank } }
      } }
    }
  }`

  // ---------------------------------------------------------------------------
  // Seasons
  // ---------------------------------------------------------------------------

  function currentSeason(now: number): { year: number, season: string } {
    const d = new Date(now)
    return { year: d.getFullYear(), season: SEASONS[Math.floor(d.getMonth() / 3)] }
  }

  function seasonStart(year: number, season: string): number {
    return new Date(year, SEASON_START_MONTH[season] || 0, 1).getTime()
  }

  // Current and upcoming seasons change quickly; past ones hardly at all.
  function cacheTtl(year: number, season: string): number {
    const ended = seasonStart(year, season) + 92 * 86400000 < Date.now()
    return ended ? 7 * 86400000 : 6 * 3600000
  }

  // ---------------------------------------------------------------------------
  // AniList
  // ---------------------------------------------------------------------------

  // An AniList error (rate limit, outage) throws: treating it as empty data
  // would overwrite good cached data with nothing.
  function query(token: string, q: string, variables: any): any {
    const res: any = $anilist.customQuery({ query: q, variables }, token)
    if (!res || (res.errors && !res.data)) {
      throw new Error("AniList didn't answer" + (res && res.errors ? ": " + JSON.stringify(res.errors).slice(0, 120) : ""))
    }
    // customQuery may or may not unwrap "data".
    return res.data ? res.data : res
  }

  function viewerId(token: string): number {
    const cached = $storage.get("sg-viewer")
    if (cached) return cached
    const d = query(token, "query { Viewer { id } }", {})
    const id = d && d.Viewer && d.Viewer.id
    if (!id) throw new Error("could not get the AniList user")
    $storage.set("sg-viewer", id)
    return id
  }

  function seasonKey(year: number, season: string): string {
    return "sg-season-" + year + "-" + season
  }

  function cachedSeason(year: number, season: string): { items: SeasonItem[], fresh: boolean } | null {
    const cached = $storage.get(seasonKey(year, season))
    if (!cached || !cached.at || !Array.isArray(cached.items)) return null
    return { items: cached.items, fresh: Date.now() - cached.at < cacheTtl(year, season) }
  }

  // Keeps the last MAX_CACHED_SEASONS seasons; older ones are dropped.
  function storeSeason(year: number, season: string, items: SeasonItem[]) {
    const key = seasonKey(year, season)
    $storage.set(key, { at: Date.now(), items })
    let index: string[] = $storage.get("sg-season-index") || []
    index = index.filter((k) => k !== key)
    index.push(key)
    while (index.length > MAX_CACHED_SEASONS) $storage.remove(index.shift() as string)
    $storage.set("sg-season-index", index)
  }

  // Public season data straight from AniList, so the pages can load in
  // parallel: Seanime's client runs one request at a time and blocks the
  // plugin meanwhile. No token is sent.
  async function gql(q: string, variables: any): Promise<any> {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: q, variables }),
    })
    if (!res.ok) throw new Error("AniList HTTP " + res.status)
    const j: any = await res.json()
    if (j.errors) throw new Error("AniList: " + JSON.stringify(j.errors).slice(0, 200))
    return j.data
  }

  async function downloadSeason(token: string, year: number, season: string): Promise<SeasonItem[]> {
    const items: SeasonItem[] = []
    const seen: { [id: number]: boolean } = {}
    const take = (d: any) => {
      for (const m of ((d && d.Page && d.Page.media) || [])) {
        if (m && !seen[m.id]) { seen[m.id] = true; items.push(toItem(m)) }
      }
    }
    try {
      // Most seasons fit in 3 pages; ask for them at once, then go on if needed.
      const first = await Promise.all([1, 2, 3].map((p) => gql(SEASON_QUERY, { season, year, p })))
      first.forEach(take)
      let last = first[2]
      for (let p = 4; p <= MAX_PAGES && last && last.Page && last.Page.pageInfo && last.Page.pageInfo.hasNextPage; p++) {
        last = await gql(SEASON_QUERY, { season, year, p })
        take(last)
      }
      return items
    } catch (e) {
      // Rate limit or no network access: fall back to Seanime's client.
      console.error("Season Guide: direct AniList request failed, using Seanime's client: " + e)
      items.length = 0
      for (const k in seen) delete seen[k as any]
      for (let p = 1; p <= MAX_PAGES; p++) {
        const d = query(token, SEASON_QUERY, { season, year, p })
        // No page at all (rate limit, network): an error, not an empty season.
        if (p === 1 && !(d && d.Page)) throw new Error("AniList didn't answer, try again in a minute")
        take(d)
        if (!d || !d.Page || !d.Page.pageInfo || !d.Page.pageInfo.hasNextPage) break
      }
      return items
    }
  }

  async function fetchSeason(token: string, year: number, season: string, force?: boolean): Promise<SeasonItem[]> {
    const cached = cachedSeason(year, season)
    if (!force && cached && cached.fresh) return cached.items
    const items = await downloadSeason(token, year, season)
    storeSeason(year, season, items)
    return items
  }

  function neighbours(year: number, season: string): { year: number, season: string }[] {
    const i = SEASONS.indexOf(season)
    return [
      i > 0 ? { year, season: SEASONS[i - 1] } : { year: year - 1, season: "FALL" },
      i < 3 ? { year, season: SEASONS[i + 1] } : { year: year + 1, season: "WINTER" },
    ]
  }

  // Loads the previous and next seasons into the cache, one after another.
  let prefetching = false
  async function prefetchAround(year: number, season: string) {
    if (prefetching) return
    prefetching = true
    try {
      const token = $database.anilist.getToken()
      for (const n of neighbours(year, season)) {
        const cached = cachedSeason(n.year, n.season)
        if (cached && cached.fresh) continue
        try { await fetchSeason(token, n.year, n.season) } catch (e) { console.error("Season Guide: prefetch: " + e) }
      }
    } finally {
      prefetching = false
    }
  }

  function toItem(m: any): SeasonItem {
    const sd = m.startDate || {}
    const dist = (m.stats && m.stats.scoreDistribution) || []
    let votes = 0
    for (const x of dist) votes += x.amount || 0
    const tags: string[] = []
    for (const t of (m.tags || [])) if (t && t.rank >= 60 && tags.length < 8) tags.push(t.name)
    return {
      id: m.id,
      idMal: m.idMal || 0,
      title: (m.title && m.title.userPreferred) || "?",
      cover: (m.coverImage && (m.coverImage.medium || m.coverImage.large)) || "",
      coverLarge: (m.coverImage && (m.coverImage.large || m.coverImage.medium)) || "",
      banner: m.bannerImage || "",
      color: (m.coverImage && m.coverImage.color) || "",
      format: m.format || "",
      episodes: m.episodes || 0,
      duration: m.duration || 0,
      status: m.status || "",
      start: [sd.year || 0, sd.month || 0, sd.day || 0],
      genres: m.genres || [],
      studios: ((m.studios && m.studios.nodes) || []).map((s: any) => s.name),
      tags,
      score: m.averageScore || 0,
      votes,
      popularity: m.popularity || 0,
      trending: m.trending || 0,
      nextEpisode: (m.nextAiringEpisode && m.nextAiringEpisode.episode) || 0,
      nextAiringAt: (m.nextAiringEpisode && m.nextAiringEpisode.airingAt) || 0,
    }
  }

  // ---------------------------------------------------------------------------
  // Taste
  // ---------------------------------------------------------------------------

  // How much you like each genre, studio and tag, from your AniList list:
  // scored shows count by how far their score is from your average, unscored
  // ones by their status (dropped counts against). Averages are pulled
  // towards zero for features you've seen only a couple of times.
  function tasteProfile(token: string, userId: number, force?: boolean): { [feature: string]: number } {
    const cached = $storage.get(TASTE_KEY)
    if (!force && cached && cached.at && cached.userId === userId && Date.now() - cached.at < 86400000) return cached.affinity

    const d = query(token, TASTE_QUERY, { u: userId })
    if (!d || !d.MediaListCollection) throw new Error("AniList returned no list")
    const lists: any[] = d.MediaListCollection.lists || []
    const entries: any[] = []
    for (const l of lists) for (const e of (l.entries || [])) if (e && e.media) entries.push(e)

    const scores = entries.filter((e) => e.score > 0).map((e) => e.score)
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 70
    const sd = scores.length > 1
      ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length)
      : 10
    const byStatus: { [s: string]: number } = { COMPLETED: 0.4, REPEATING: 0.6, CURRENT: 0.25, PAUSED: 0, DROPPED: -1, PLANNING: 0.15 }

    const sum: { [f: string]: number } = {}
    const weight: { [f: string]: number } = {}
    for (const e of entries) {
      const w = e.score > 0
        ? Math.max(-2, Math.min(2, (e.score - mean) / Math.max(sd, 5)))
        : (byStatus[e.status] || 0)
      const add = (f: string, fw: number) => {
        sum[f] = (sum[f] || 0) + w * fw
        weight[f] = (weight[f] || 0) + fw
      }
      for (const g of (e.media.genres || [])) add("g:" + g, 1)
      for (const s of ((e.media.studios && e.media.studios.nodes) || [])) add("s:" + s.name, 0.8)
      for (const t of (e.media.tags || [])) if (t && t.rank >= 60) add("t:" + t.name, (t.rank / 100) * 0.6)
    }
    const affinity: { [f: string]: number } = {}
    for (const f in sum) affinity[f] = sum[f] / (weight[f] + 2)

    $storage.set(TASTE_KEY, { at: Date.now(), userId, affinity })
    return affinity
  }

  // 0-100: how well a show's genres, studio and tags fit your taste.
  function matchOf(item: SeasonItem, affinity: { [f: string]: number }): number {
    let total = 0
    let weights = 0
    const add = (f: string, fw: number) => {
      total += (affinity[f] || 0) * fw
      weights += fw
    }
    for (const g of item.genres) add("g:" + g, 1)
    for (const s of item.studios) add("s:" + s, 0.8)
    for (const t of item.tags) add("t:" + t, 0.5)
    // The extra weight pulls shows we know little about (one genre, no tags)
    // towards 50% instead of letting a single feature decide.
    const raw = total / (weights + 1.5)
    return Math.round(100 / (1 + Math.exp(-raw * 7)))
  }

  // Why a show got its match: the features that pushed it up the most and
  // down the most, with the same weights as matchOf(). Features you feel
  // about weakly either way are left out.
  function explainMatch(item: SeasonItem, affinity: { [f: string]: number }): { p: string[], n: string[] } {
    const parts: { name: string, v: number }[] = []
    const add = (f: string, name: string, fw: number) => {
      const a = affinity[f] || 0
      if (Math.abs(a) >= 0.08) parts.push({ name, v: a * fw })
    }
    for (const g of item.genres) add("g:" + g, g, 1)
    for (const s of item.studios) add("s:" + s, s, 0.8)
    for (const t of item.tags) add("t:" + t, t, 0.5)
    const p = parts.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => x.name)
    const n = parts.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.name)
    return { p, n }
  }

  // ---------------------------------------------------------------------------
  // Tier list
  // ---------------------------------------------------------------------------

  // The season's top 10 as a 1-2-3-4 pyramid. Ranking: the AniList score,
  // weighted by how many people voted (a 9.0 from a few hundred doesn't beat
  // an 8.5 from tens of thousands), plus how popular it is within the season.
  // Early in a season popularity counts more; before it starts, it's all
  // there is ("most anticipated").
  function rankSeason(items: SeasonItem[], year: number, season: string, now: number): any {
    const pool = items.filter((i) => TIER_FORMATS[i.format])
    if (pool.length === 0) return { mode: "none", tiers: [] }

    const start = seasonStart(year, season)
    const scored = pool.filter((i) => i.score > 0)
    let mode = "final"
    if (now < start || scored.length === 0) mode = "anticipated"
    else if (now < start + EARLY_DAYS * 86400000 || scored.length < pool.length * 0.4) mode = "early"

    const byPop = pool.slice().sort((a, b) => b.popularity - a.popularity)
    const popPct: { [id: number]: number } = {}
    byPop.forEach((i, idx) => { popPct[i.id] = byPop.length > 1 ? 1 - idx / (byPop.length - 1) : 1 })

    const meanScore = scored.length ? scored.reduce((a, i) => a + i.score, 0) / scored.length : 70
    const votes = scored.map((i) => i.votes).sort((a, b) => a - b)
    const m = Math.max(50, votes.length ? votes[Math.floor(votes.length * 0.4)] : 50)

    const rank: { id: number, value: number }[] = pool.map((i) => {
      const weighted = i.score > 0 ? (i.votes / (i.votes + m)) * i.score + (m / (i.votes + m)) * meanScore : meanScore - 8
      const pop = popPct[i.id] * 100
      let value = 0.75 * weighted + 0.25 * pop
      if (mode === "early") value = 0.5 * weighted + 0.5 * pop
      if (mode === "anticipated") value = pop + i.trending / 1000
      return { id: i.id, value }
    })
    rank.sort((a, b) => b.value - a.value)

    const tiers: any[] = []
    let at = 0
    for (const [tier, size] of TIER_SIZES) {
      const ids = rank.slice(at, at + size).map((r) => r.id)
      if (ids.length) tiers.push({ tier, ids })
      at += size
    }
    return { mode, tiers }
  }

  // ---------------------------------------------------------------------------
  // AniLiberty dubs and your list
  // ---------------------------------------------------------------------------

  // MAL ids of the season's releases on AniLiberty; null if it couldn't be checked.
  async function dubbedMalIds(year: number, season: string): Promise<number[] | null> {
    const key = "sg-dub-" + year + "-" + season
    const cached = $storage.get(key)
    if (cached && cached.at && Date.now() - cached.at < 12 * 3600000) return cached.ids
    try {
      const ids: number[] = []
      for (let p = 1; p <= 10; p++) {
        const url = "https://aniliberty.top/api/v1/anime/catalog/releases?page=" + p + "&limit=50" +
          "&f%5Byears%5D%5Bfrom_year%5D=" + year + "&f%5Byears%5D%5Bto_year%5D=" + year +
          "&f%5Bseasons%5D=" + ANILIBERTY_SEASON[season] + "&include=id,mal"
        const res = await fetch(url, { headers: { accept: "application/json" } })
        if (!res.ok) throw new Error("HTTP " + res.status)
        const j: any = await res.json()
        for (const r of (j.data || [])) if (r && r.mal && r.mal.id) ids.push(r.mal.id)
        const pages = j.meta && j.meta.pagination && j.meta.pagination.total_pages
        if (!pages || p >= pages) break
      }
      $storage.set(key, { at: Date.now(), ids })
      return ids
    } catch (e) {
      console.error("Season Guide: AniLiberty: " + e)
      return cached ? cached.ids : null
    }
  }

  // Your list status and progress by AniList id.
  function libraryMap(): { [id: string]: any } {
    const out: { [id: string]: any } = {}
    const collection: any = $anilist.getAnimeCollection(false)
    const lists: any[] = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
    for (const l of lists) {
      for (const e of (l.entries || [])) {
        if (e && e.media && e.media.id) out[String(e.media.id)] = { status: e.status || l.status || "", progress: e.progress || 0 }
      }
    }
    return out
  }

  function addToPlanning(mediaId: number): { [id: string]: any } | null {
    try {
      $anilist.updateEntry(mediaId, "PLANNING" as any, undefined, undefined, undefined, undefined)
      $anilist.refreshAnimeCollection()
      const library = libraryMap()
      // The refreshed collection may lag behind the update.
      if (!library[String(mediaId)]) library[String(mediaId)] = { status: "PLANNING", progress: 0 }
      return library
    } catch (e) {
      console.error("Season Guide: add to planning: " + e)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  function cleanPrefs(p: any): any {
    p = p || {}
    const sorts = ["match", "popular", "score", "date"]
    const groups = ["tv", "ona", "movie", "ova", "short"]
    const formats = Array.isArray(p.formats) ? p.formats.filter((f: string) => groups.indexOf(f) >= 0) : ["tv", "ona", "movie", "ova"]
    return {
      sort: sorts.indexOf(p.sort) >= 0 ? p.sort : "match",
      formats,
      hideInList: !!p.hideInList,
      dubOnly: !!p.dubOnly,
    }
  }

  function readPrefs(): any {
    try { return cleanPrefs($storage.get(PREFS_KEY)) } catch (e) { return cleanPrefs(null) }
  }

  function savePrefs(p: any): any {
    const prefs = cleanPrefs(Object.assign({}, readPrefs(), p || {}))
    $storage.set(PREFS_KEY, prefs)
    return prefs
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  async function loadSeason(year: number, season: string, force: boolean): Promise<any> {
    const prefs = readPrefs()
    try {
      if (SEASONS.indexOf(season) < 0) season = currentSeason(Date.now()).season
      const token = $database.anilist.getToken()
      if (!token) return { error: "Not logged in to AniList: log in in Seanime.", year, season, prefs }
      // A refresh bypasses the caches instead of clearing them first, so a
      // failed refresh still has the last good data to show.
      if (force) $storage.remove("sg-dub-" + year + "-" + season)
      // Both run over the network while the taste profile is worked out.
      const itemsP = fetchSeason(token, year, season, force)
      const dubP = dubbedMalIds(year, season)
      // Await the requests even if the taste profile fails, so none of their
      // errors goes unhandled.
      let affinity: any = null
      let tasteError: any = null
      try { affinity = tasteProfile(token, viewerId(token), force) } catch (e) { tasteError = e }
      const items = await itemsP
      const dub = await dubP
      if (tasteError) throw tasteError
      return buildPayload(year, season, items, affinity, dub, prefs, true)
    } catch (e) {
      console.error("Season Guide: " + e)
      const stale = cachedPayload(year, season)
      if (stale) return Object.assign(stale, { loading: false, warning: "Couldn't refresh: " + e })
      return { error: "Couldn't load the season: " + e, year, season, prefs }
    }
  }

  // What the page shows, from cached data only (any age); null if the season
  // was never loaded. `fresh` says whether it still needs a refresh.
  function cachedPayload(year: number, season: string): any {
    const cached = cachedSeason(year, season)
    if (!cached) return null
    const taste = $storage.get(TASTE_KEY)
    const dub = $storage.get("sg-dub-" + year + "-" + season)
    const p = buildPayload(year, season, cached.items, (taste && taste.affinity) || {}, dub ? dub.ids : null, readPrefs(), !!taste)
    p.fresh = cached.fresh && !!taste
    return p
  }

  function buildPayload(year: number, season: string, items: SeasonItem[], affinity: any, dub: number[] | null, prefs: any, hasTaste: boolean): any {
    const match: { [id: string]: number } = {}
    const why: { [id: string]: { p: string[], n: string[] } } = {}
    if (hasTaste) {
      for (const i of items) {
        match[String(i.id)] = matchOf(i, affinity)
        why[String(i.id)] = explainMatch(i, affinity)
      }
    }
    const ranking = rankSeason(items, year, season, Date.now())
    return {
      year, season, items, match, why,
      tiers: ranking.tiers, mode: ranking.mode,
      library: libraryMap(),
      dub,
      prefs,
      updatedAt: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe). A plain template literal: no
  // backslashes and no interpolation inside, so nothing to escape.
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: #0b0b0d; --paper: #131317; --paper2: #1a1a20; --line: #26262e;
    --text: #ececf1; --muted: #8a8a96; --brand: #7c6cf2; --on-brand: #fff;
    --yellow: #e6b422; --green: #3fbf6a; --blue: #5b8def;
    --s: #ff7f7f; --a: #ffbf7f; --b: #ffdf7f; --c: #bfff7f;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color-scheme: dark; }
  html, body { margin: 0; color: var(--text); font: 14px/1.4 Inter, "Segoe UI", system-ui, sans-serif; }
  body { position: relative; overflow-x: hidden; }
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 440px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .5;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .6; }
  .wrap { position: relative; padding: 8px 4px 32px; max-width: 1600px; margin: 0 auto; }
  h1 { margin: 0; font-weight: 700; letter-spacing: -.01em; }
  h2 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--paper2); border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: #3a3a46; background: #202028; }
  .seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; }
  .seg button { border: 0; background: transparent; padding: 5px 11px; border-radius: 8px; color: var(--muted); }
  .seg button.on { background: var(--brand); color: var(--on-brand); font-weight: 600; }
  .chip-btn { border-radius: 99px; padding: 4px 11px; font-size: 13px; color: var(--muted); }
  .chip-btn.on { border-color: var(--brand); color: var(--text); background: color-mix(in srgb, var(--brand) 20%, var(--paper2)); }
  section { background: rgba(19,19,23,.86); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin-top: 16px; }
  .head { min-height: 170px; align-items: flex-end; padding-bottom: 6px; }
  .head h1 { font-size: 34px; text-shadow: 0 2px 12px rgba(0,0,0,.6); }
  .head .sub { font-size: 13px; color: #d4d4dc; text-shadow: 0 1px 6px rgba(0,0,0,.8); margin-top: 2px; }

  /* Tier list */
  .tier { display: flex; align-items: stretch; border-top: 1px solid var(--line); }
  .tier:first-of-type { border-top: 0; }
  .tier-label { width: 64px; flex: none; display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 800; color: #1b1b1f; border-radius: 10px; margin: 6px 12px 6px 0; }
  .tier-items { display: flex; gap: 10px; flex-wrap: wrap; padding: 6px 0; flex: 1; }
  .tcard { display: flex; gap: 10px; width: 300px; background: var(--paper2); border: 1px solid var(--line);
    border-radius: 12px; padding: 8px; cursor: pointer; position: relative; }
  .tcard:hover { border-color: var(--brand); }
  .tcard img { width: 58px; height: 82px; object-fit: cover; border-radius: 7px; flex: none; }
  .tcard .rank { position: absolute; left: -6px; top: -6px; background: var(--paper); border: 1px solid var(--line);
    border-radius: 99px; font-size: 11px; font-weight: 700; padding: 1px 7px; }
  .tier.S .tcard { width: 380px; }
  .tier.S .tcard img { width: 76px; height: 108px; }
  .tier.S .tcard .t { font-size: 16px; }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 10px; }
  .card { display: flex; gap: 12px; padding: 10px; background: var(--paper2); border: 1px solid var(--line);
    border-radius: 12px; cursor: pointer; }
  .card:hover { border-color: var(--brand); }
  .card img { width: 84px; height: 120px; object-fit: cover; border-radius: 8px; flex: none; background: #222; }
  .card .body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .t { font-weight: 650; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .meta { font-size: 12px; color: var(--muted); }
  .genres { display: flex; flex-wrap: wrap; gap: 4px; }
  .genre { font-size: 11px; background: #23232b; border-radius: 99px; padding: 1px 7px; color: #b9b9c3; }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: auto; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 99px; }
  .pill.match { background: color-mix(in srgb, var(--brand) 22%, transparent); color: var(--text); cursor: help; }
  #tip { position: absolute; display: none; z-index: 50; max-width: 320px; pointer-events: none;
    background: #1f1f27; border: 1px solid #34343f; border-radius: 10px; padding: 10px 12px; font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  #tip b { font-size: 13px; display: block; margin-bottom: 6px; }
  #tip div { margin-top: 3px; }
  .tip-row { display: flex; gap: 8px; }
  .tip-label { flex: none; width: 96px; color: var(--muted); }
  .tip-label.good { color: var(--green); }
  .tip-label.bad { color: #ff8a8a; }
  .tip-foot { color: var(--muted); font-size: 11px; margin-top: 8px !important; }
  .pill.dub { background: rgba(63,191,106,.15); color: var(--green); }
  .pill.list { background: rgba(230,180,34,.14); color: var(--yellow); }
  .score { font-size: 12px; font-weight: 650; }
  /* Tint by status in your list, as in Anime Diary */
  .card, .tcard { position: relative; overflow: hidden; }
  .st-done { background: color-mix(in srgb, var(--green) 14%, var(--paper2)); border-color: color-mix(in srgb, var(--green) 45%, var(--line)); }
  .st-watching { background: color-mix(in srgb, var(--yellow) 12%, var(--paper2)); border-color: color-mix(in srgb, var(--yellow) 40%, var(--line)); }
  .st-planned { background: color-mix(in srgb, var(--blue) 12%, var(--paper2)); border-color: color-mix(in srgb, var(--blue) 40%, var(--line)); }
  .st-dropped { background: color-mix(in srgb, #000 25%, var(--paper2)); opacity: .7; }
  .st-done .pill.list { background: rgba(63,191,106,.18); color: var(--green); }
  .st-planned .pill.list { background: rgba(91,141,239,.18); color: var(--blue); }
  .st-dropped .pill.list { background: rgba(120,120,130,.2); color: #a0a0aa; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.06); }
  .progress div { height: 100%; background: var(--yellow); }
  .legend { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-left: 8px; }
  .plan { padding: 2px 9px; font-size: 12px; border-radius: 8px; margin-left: auto; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .error { color: #ff8a8a; }
  .note { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="hero" id="hero"></div>
<div class="wrap" id="root"><div class="empty">Loading the season…</div></div>
<div id="tip"></div>
<script>
var DATA = null;
var PREFS = { sort: "match", formats: ["tv", "ona", "movie", "ova"], hideInList: false, dubOnly: false };
var SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
var SEASON_NAME = { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" };
var FORMAT_GROUP = { TV: "tv", TV_SHORT: "short", ONA: "ona", MOVIE: "movie", OVA: "ova", SPECIAL: "ova", MUSIC: "short" };
var FORMAT_NAME = { TV: "TV", TV_SHORT: "TV Short", ONA: "ONA", MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special", MUSIC: "Music" };
var GROUPS = [["tv", "TV"], ["ona", "ONA"], ["movie", "Movie"], ["ova", "OVA / Special"], ["short", "Shorts"]];
var LIST_NAME = { CURRENT: "Watching", PLANNING: "Planning", COMPLETED: "Completed", PAUSED: "Paused", DROPPED: "Dropped", REPEATING: "Rewatching" };
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function send(ev, p) { window.webview.send(ev, p || {}); }
function byId() { var m = {}; (DATA.items || []).forEach(function (i) { m[i.id] = i; }); return m; }
function isDubbed(i) { return !!(DATA.dub && i.idMal && DATA.dub.indexOf(i.idMal) >= 0); }
function listOf(i) { return (DATA.library || {})[String(i.id)] || null; }
function matchOf(i) { return (DATA.match || {})[String(i.id)] || 0; }

function hexToRgb(h) {
  if (!h || h.charAt(0) !== "#" || h.length !== 7) return null;
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
// Banner and accent colour of the season's S-tier show.
function applyTheme(top) {
  var hero = document.getElementById("hero");
  var img = top && (top.banner || top.coverLarge);
  hero.style.backgroundImage = img ? 'url("' + String(img).replace(/"/g, "%22") + '")' : "none";
  hero.className = "hero" + (top && !top.banner ? " cover" : "");
  var css = document.documentElement.style;
  var rgb = top && hexToRgb(top.color);
  var brand = "#7c6cf2", onBrand = "#fff";
  if (rgb) {
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    var spread = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    if (lum > 0.22 && lum < 0.85 && spread > 40) { brand = top.color; onBrand = lum > 0.6 ? "#111" : "#fff"; }
  }
  css.setProperty("--brand", brand);
  css.setProperty("--on-brand", onBrand);
}

function dateOf(i) {
  if (i.nextAiringAt) {
    var d = new Date(i.nextAiringAt * 1000);
    return "Ep " + i.nextEpisode + " · " + MONTHS[d.getMonth()] + " " + d.getDate();
  }
  if (i.start[1]) return MONTHS[i.start[1] - 1] + (i.start[2] ? " " + i.start[2] : "") + (i.start[0] ? ", " + i.start[0] : "");
  return "TBA";
}
function listBadge(i) {
  var l = listOf(i);
  if (!l) return "";
  var name = LIST_NAME[l.status] || l.status;
  var progress = (l.status === "CURRENT" || l.status === "PAUSED") && l.progress ? " " + l.progress + "/" + (i.episodes || "?") : "";
  return '<span class="pill list">' + esc(name + progress) + '</span>';
}
// The card is tinted by the show's status in your list.
var STATUS_CLASS = { COMPLETED: "done", CURRENT: "watching", REPEATING: "watching", PAUSED: "watching", PLANNING: "planned", DROPPED: "dropped" };
function statusClass(i) { var l = listOf(i); return l && STATUS_CLASS[l.status] ? " st-" + STATUS_CLASS[l.status] : ""; }
function progressBar(i) {
  var l = listOf(i);
  if (!l || (l.status !== "CURRENT" && l.status !== "PAUSED" && l.status !== "REPEATING") || !l.progress) return "";
  var total = i.episodes || (i.nextEpisode ? i.nextEpisode - 1 : 0);
  if (!total) return "";
  return '<div class="progress"><div style="width:' + Math.min(100, Math.round(l.progress / total * 100)) + '%"></div></div>';
}
// No match until the taste profile is ready (a season shown from the cache on the first visit).
function matchPill(i) { var m = matchOf(i); return m ? '<span class="pill match" data-why="' + i.id + '">' + m + '% match</span>' : ''; }

// ---------- match tooltip ----------
// One floating box for the whole page, so the cards' clipping doesn't cut it.
function tooltipHtml(id) {
  var m = (DATA.match || {})[String(id)];
  var w = (DATA.why || {})[String(id)] || { p: [], n: [] };
  var lines = '<b>' + m + '% match</b>';
  if (w.p.length) lines += '<div class="tip-row"><span class="tip-label good">You like</span><span>' + esc(w.p.join(", ")) + '</span></div>';
  if (w.n.length) lines += '<div class="tip-row"><span class="tip-label bad">Not your thing</span><span>' + esc(w.n.join(", ")) + '</span></div>';
  if (!w.p.length && !w.n.length) lines += '<div class="muted">Not enough in common with your list to tell — neutral.</div>';
  return lines + '<div class="tip-foot">From genres, studios and tags of what you scored and watched on AniList.</div>';
}
function showTip(el) {
  var tip = document.getElementById("tip");
  tip.innerHTML = tooltipHtml(el.getAttribute("data-why"));
  tip.style.display = "block";
  var r = el.getBoundingClientRect();
  var left = Math.min(r.left + window.scrollX, document.documentElement.clientWidth - tip.offsetWidth - 8);
  var top = r.top + window.scrollY - tip.offsetHeight - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}
function hideTip() { var tip = document.getElementById("tip"); if (tip) tip.style.display = "none"; }
document.addEventListener("mouseover", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-why]") : null;
  if (el) showTip(el); else hideTip();
});
document.addEventListener("scroll", hideTip, true);
function scoreText(i) { return i.score ? "★ " + (i.score / 10).toFixed(1) : "★ —"; }

// ---------- header ----------
function renderHead(top) {
  var y = DATA.year, s = DATA.season;
  var seasonTabs = SEASONS.map(function (x) {
    return '<button data-act="season" data-v="' + x + '" class="' + (x === s ? "on" : "") + '">' + SEASON_NAME[x] + '</button>';
  }).join("");
  var count = DATA.items ? DATA.items.length + " anime" : "";
  return '<div class="row head"><div><h1>Season Guide</h1><div class="sub">' + SEASON_NAME[s] + ' ' + y + (count ? ' · ' + count : '') +
    (DATA.loading ? ' · loading…' : '') +
    (DATA.warning ? ' · <span class="error">' + esc(DATA.warning) + '</span>' : '') + '</div></div><span class="spacer"></span>' +
    '<button data-act="year" data-v="-1">‹</button><b style="min-width:44px;text-align:center">' + y + '</b><button data-act="year" data-v="1">›</button>' +
    '<span class="seg">' + seasonTabs + '</span>' +
    '<button data-act="refresh" title="Fetch the season again from AniList">Refresh</button></div>';
}

// ---------- tier list ----------
function renderTiers(map) {
  if (!DATA.tiers || !DATA.tiers.length) return "";
  var note = DATA.mode === "anticipated" ? "Hasn't started yet: ranked by popularity — the most anticipated shows."
    : DATA.mode === "early" ? "Early ratings: the season just started, so popularity counts as much as scores for now."
    : "Ranked by AniList score, weighted by the number of votes, and popularity this season.";
  var title = DATA.mode === "anticipated" ? "Most anticipated" : "Top 10 this season";
  var rank = 0;
  var rows = DATA.tiers.map(function (t) {
    var cards = t.ids.map(function (id) {
      var i = map[id]; rank++;
      if (!i) return "";
      return '<div class="tcard' + statusClass(i) + '" data-open="' + i.id + '"><span class="rank">#' + rank + '</span>' +
        '<img src="' + esc(i.coverLarge || i.cover) + '" loading="lazy">' +
        '<div class="body"><div class="t">' + esc(i.title) + '</div>' +
        '<div class="meta">' + esc(FORMAT_NAME[i.format] || i.format) + (i.studios[0] ? ' · ' + esc(i.studios[0]) : '') + '</div>' +
        '<div class="pills"><span class="score">' + scoreText(i) + '</span>' + matchPill(i) + listBadge(i) + '</div></div>' +
        progressBar(i) + '</div>';
    }).join("");
    return '<div class="tier ' + t.tier + '"><div class="tier-label" style="background:var(--' + t.tier.toLowerCase() + ')">' + t.tier + '</div>' +
      '<div class="tier-items">' + cards + '</div></div>';
  }).join("");
  return '<section><div class="row" style="margin-bottom:10px"><h2>' + title + '</h2><span class="note">' + note + '</span></div>' + rows + '</section>';
}

// ---------- all anime ----------
function visibleItems() {
  var items = (DATA.items || []).filter(function (i) {
    if (PREFS.formats.indexOf(FORMAT_GROUP[i.format] || "tv") < 0) return false;
    if (PREFS.hideInList && listOf(i)) return false;
    if (PREFS.dubOnly && !isDubbed(i)) return false;
    return true;
  });
  var key = PREFS.sort;
  items.sort(function (a, b) {
    if (key === "popular") return b.popularity - a.popularity;
    if (key === "score") return (b.score - a.score) || (b.popularity - a.popularity);
    if (key === "date") {
      var da = a.start[0] * 10000 + a.start[1] * 100 + a.start[2], db = b.start[0] * 10000 + b.start[1] * 100 + b.start[2];
      return (da || 99999999) - (db || 99999999);
    }
    return (forYou(b) - forYou(a)) || (b.popularity - a.popularity);
  });
  return items;
}
// Taste first, with a nudge for quality: a well-matched show rated 5.6
// shouldn't sit above an equally matched 8.3. Unrated shows get no nudge.
function forYou(i) { return matchOf(i) + (i.score ? (i.score - 70) * 0.4 : 0); }
function renderAll() {
  var items = visibleItems();
  var sorts = [["match", "For you"], ["popular", "Popular"], ["score", "Top rated"], ["date", "Air date"]];
  var sortSeg = '<span class="seg">' + sorts.map(function (s) {
    return '<button data-act="sort" data-v="' + s[0] + '" class="' + (PREFS.sort === s[0] ? "on" : "") + '">' + s[1] + '</button>';
  }).join("") + '</span>';
  var formatChips = GROUPS.map(function (g) {
    return '<button class="chip-btn' + (PREFS.formats.indexOf(g[0]) >= 0 ? " on" : "") + '" data-act="format" data-v="' + g[0] + '">' + g[1] + '</button>';
  }).join("");
  var toggles = '<button class="chip-btn' + (PREFS.hideInList ? " on" : "") + '" data-act="toggle" data-v="hideInList">Hide my list</button>' +
    '<button class="chip-btn' + (PREFS.dubOnly ? " on" : "") + '" data-act="toggle" data-v="dubOnly"' +
    (DATA.dub === null ? ' title="AniLiberty could not be reached"' : '') + '>AniLiberty dub only</button>';

  var cards = items.map(function (i) {
    var plan = listOf(i) ? '' : '<button class="plan" data-act="plan" data-id="' + i.id + '" title="Add to Planning on AniList">+ Plan</button>';
    return '<div class="card' + statusClass(i) + '" data-open="' + i.id + '"><img src="' + esc(i.coverLarge || i.cover) + '" loading="lazy">' +
      '<div class="body"><div class="t">' + esc(i.title) + '</div>' +
      '<div class="meta">' + esc(FORMAT_NAME[i.format] || i.format) + (i.episodes ? ' · ' + i.episodes + ' eps' : '') + ' · ' + esc(dateOf(i)) + '</div>' +
      (i.studios[0] ? '<div class="meta">' + esc(i.studios.join(", ")) + '</div>' : '') +
      '<div class="genres">' + i.genres.slice(0, 3).map(function (g) { return '<span class="genre">' + esc(g) + '</span>'; }).join("") + '</div>' +
      '<div class="pills"><span class="score">' + scoreText(i) + '</span>' + matchPill(i) + listBadge(i) + plan + '</div></div>' +
      progressBar(i) + '</div>';
  }).join("");

  return '<section><div class="row" style="margin-bottom:12px"><h2>All anime <span class="muted">· ' + items.length + '</span></h2>' +
    '<span class="spacer"></span>' + sortSeg + '</div>' +
    '<div class="row" style="margin-bottom:12px">' + formatChips + '<span style="width:12px"></span>' + toggles +
    '<span class="spacer"></span><span class="legend"><i style="background:var(--green)"></i>completed' +
    '<i style="background:var(--yellow)"></i>watching<i style="background:var(--blue)"></i>planning' +
    '<i style="background:var(--gray, #6b6b76)"></i>dropped</span></div>' +
    (items.length ? '<div class="cards">' + cards + '</div>' : '<div class="empty">Nothing matches the filters.</div>') + '</section>';
}

function render() {
  var root = document.getElementById("root");
  if (!DATA) { root.innerHTML = '<div class="empty">Loading the season…</div>'; return; }
  var map = DATA.items ? byId() : {};
  var top = DATA.tiers && DATA.tiers[0] ? map[DATA.tiers[0].ids[0]] : null;
  applyTheme(top);
  var body = DATA.error ? '<section><div class="empty error">' + esc(DATA.error) + '</div></section>'
    : !DATA.items ? '<section><div class="empty">Loading the season…</div></section>'
    : DATA.items.length === 0 ? '<section><div class="empty">AniList has no anime for this season yet.</div></section>'
    : renderTiers(map) + renderAll();
  root.innerHTML = renderHead(top) + body;
}

function go(year, season) {
  DATA = Object.assign({}, DATA, { year: year, season: season, items: null, tiers: [], loading: true, error: null });
  render();
  send("load-season", { year: year, season: season });
}
function setPref(p) {
  for (var k in p) PREFS[k] = p[k];
  send("set-prefs", p);
  render();
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act],[data-open]") : null;
  if (!el) return;
  var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
  if (act === "plan") { send("plan", { id: Number(el.getAttribute("data-id")) }); el.disabled = true; el.textContent = "Added"; return; }
  var id = el.getAttribute("data-open");
  if (id) { send("open", { id: Number(id) }); return; }
  if (!DATA) return;
  if (act === "season") go(DATA.year, v);
  else if (act === "year") go(DATA.year + Number(v), DATA.season);
  else if (act === "refresh") { DATA.loading = true; render(); send("refresh"); }
  else if (act === "sort") setPref({ sort: v });
  else if (act === "format") {
    var f = PREFS.formats.slice(), at = f.indexOf(v);
    if (at >= 0) f.splice(at, 1); else f.push(v);
    setPref({ formats: f });
  }
  else if (act === "toggle") { var p = {}; p[v] = !PREFS[v]; setPref(p); }
});

window.webview.on("data", function (d) {
  DATA = d;
  if (d && d.prefs) PREFS = d.prefs;
  render();
});
render();
</script>
</body>
</html>`

  return { ICON, PAGE_HTML, currentSeason, loadSeason, cachedPayload, prefetchAround, addToPlanning, savePrefs, rankSeason, matchOf }
}
