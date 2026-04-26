// api/scrape.js — fetches a URL via multiple strategies and extracts recipe JSON-LD

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url parameter' })

  let html = ''

  // Strategy 1: Direct fetch with realistic browser headers
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  }

  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) })
    if (r.ok) html = await r.text()
  } catch (e) {}

  // Strategy 2: allorigins proxy if direct fetch failed or got blocked (Cloudflare page etc.)
  if (!html || html.includes('cf-browser-verification') || html.includes('challenge-platform') || html.length < 500) {
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`
      const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) })
      if (r.ok) {
        const data = await r.json()
        if (data?.contents && data.contents.length > 500) html = data.contents
      }
    } catch (e) {}
  }

  if (!html || html.length < 200) {
    return res.status(422).json({
      error: 'Could not fetch this page — the site may be blocking automated requests.',
      partial: false
    })
  }

  // Parse JSON-LD
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []

  for (const block of jsonLdMatches) {
    const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim()
    try {
      const data = JSON.parse(inner)
      const candidates = []
      if (Array.isArray(data)) candidates.push(...data)
      else { candidates.push(data); if (data['@graph']) candidates.push(...data['@graph']) }

      for (const item of candidates) {
        if (!item) continue
        const type = item['@type']
        const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))
        if (!isRecipe) continue

        const name = item.name || ''
        const ingredients = (item.recipeIngredient || []).join('\n')
        const instructions = (item.recipeInstructions || []).map(i => {
          if (typeof i === 'string') return i
          if (i['@type'] === 'HowToSection') return (i.itemListElement || []).map(s => s.text || s.name || '').filter(Boolean).join('\n')
          return i.text || i.name || ''
        }).filter(Boolean).join('\n')

        if (name && (ingredients || instructions)) {
          return res.status(200).json({
            name, ingredients, instructions, url,
            source: (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })()
          })
        }
      }
    } catch (e) {}
  }

  // Fallback: grab title only
  const h1 = (html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1] || ''
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || ''
  const name = (h1 || title).split(/[|\-–]/)[0].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'")

  return res.status(200).json({
    name, ingredients: '', instructions: '', url,
    source: (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })(),
    partial: true,
    warning: 'Could not find structured recipe data on this page — please paste the ingredients and instructions manually.'
  })
}
