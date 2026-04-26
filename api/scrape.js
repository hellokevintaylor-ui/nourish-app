// api/scrape.js — fetches a URL and extracts recipe data from JSON-LD

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url parameter' })

  let html = ''
  let fetchError = ''

  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ]

  for (const ua of userAgents) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      })
      if (response.ok) {
        html = await response.text()
        break
      } else {
        fetchError = `HTTP ${response.status}`
      }
    } catch (e) {
      fetchError = e.message
    }
  }

  if (!html) {
    return res.status(422).json({
      error: `Could not fetch page: ${fetchError}. This site may block automated requests.`,
      partial: false
    })
  }

  // Try JSON-LD first
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []

  for (const block of jsonLdMatches) {
    const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim()
    try {
      const data = JSON.parse(inner)
      const candidates = []
      if (Array.isArray(data)) candidates.push(...data)
      else { candidates.push(data); if (data['@graph']) candidates.push(...data['@graph']) }

      for (const item of candidates) {
        const type = item && item['@type']
        if (!type) continue
        const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))
        if (!isRecipe) continue

        const name = item.name || ''
        const ingredients = (item.recipeIngredient || []).join('\n')
        const instructionList = item.recipeInstructions || []
        const instructions = instructionList.map(i => {
          if (typeof i === 'string') return i
          if (i['@type'] === 'HowToSection') return (i.itemListElement || []).map(s => s.text || s.name || '').join('\n')
          return i.text || i.name || ''
        }).filter(Boolean).join('\n')

        if (name && (ingredients || instructions)) {
          return res.status(200).json({
            name,
            ingredients,
            instructions,
            url,
            source: (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })()
          })
        }
      }
    } catch (e) {}
  }

  // Fallback: just get the title
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const rawTitle = titleMatch ? titleMatch[1].trim() : ''
  const name = rawTitle.split(/[|\-–]/)[0].trim()

  return res.status(200).json({
    name,
    ingredients: '',
    instructions: '',
    url,
    source: (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })(),
    partial: true,
    warning: 'Could not find structured recipe data — please fill in ingredients and instructions manually.'
  })
}
