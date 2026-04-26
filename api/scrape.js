// api/scrape.js — fetches a URL and extracts recipe data from JSON-LD or DOM heuristics

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url parameter' })

  let html = ''
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow'
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    html = await response.text()
  } catch (e) {
    return res.status(422).json({ error: `Could not fetch page: ${e.message}` })
  }

  // ── Try JSON-LD first ─────────────────────────────────────────────────────
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []

  for (const block of jsonLdMatches) {
    const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim()
    try {
      const parsed = JSON.parse(inner)
      const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])]
      for (const item of candidates) {
        const type = item['@type']
        if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
          const name = item.name || ''
          const ingredients = (item.recipeIngredient || []).join('\n')
          const instructions = (item.recipeInstructions || [])
            .map(i => typeof i === 'string' ? i : (i.text || i.name || '')).filter(Boolean).join('\n')
          const description = item.description || ''
          if (name && (ingredients || instructions)) {
            return res.status(200).json({ name, ingredients, instructions, description, url, source: new URL(url).hostname.replace('www.', '') })
          }
        }
      }
    } catch (e) {}
  }

  // ── Fallback: basic meta + title ──────────────────────────────────────────
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = titleMatch ? titleMatch[1].split(/[|\-–]/)[0].trim() : ''

  const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || ''
  const name = ogTitle || title || ''

  // Try to find ingredient lists by common class patterns
  const ingPattern = /class=["'][^"']*ingred[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|p|div|span)>/gi
  const ingMatches = []
  let m
  while ((m = ingPattern.exec(html)) !== null && ingMatches.length < 30) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()
    if (text.length > 2 && text.length < 200) ingMatches.push(text)
  }

  return res.status(200).json({
    name,
    ingredients: ingMatches.join('\n'),
    instructions: '',
    description: '',
    url,
    source: (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })(),
    partial: true
  })
}
