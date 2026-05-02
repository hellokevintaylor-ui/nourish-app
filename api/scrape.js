// api/scrape.js — fetches a URL and extracts recipe data, with AI fallback

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url parameter' })

  let html = ''

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  }

  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) })
    if (r.ok) html = await r.text()
  } catch (e) {}

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
    return res.status(422).json({ error: 'Could not fetch this page — the site may be blocking automated requests.' })
  }

  const source = (() => { try { return new URL(url).hostname.replace('www.', '') } catch(e) { return '' } })()

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
          return res.status(200).json({ name, ingredients, instructions, url, source })
        }
      }
    } catch (e) {}
  }

  // Strip HTML tags to get readable text for AI
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{3,}/g, '\n')
    .trim()
    .slice(0, 12000)

  // Get title for fallback
  const h1 = (html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1] || ''
  const titleTag = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || ''
  const fallbackName = (h1 || titleTag).split(/[|\-–]/)[0].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'")

  // AI extraction fallback
  try {
    const apiKey = process.env.miseenplace_apikey
    if (!apiKey) throw new Error('No API key')

    const prompt = `Extract the recipe from this webpage text. Return ONLY this exact structure with no extra commentary:

NAME: [recipe name]

INGREDIENTS:
[one ingredient per line with amounts, e.g. "2 cups flour"]

INSTRUCTIONS:
[numbered steps, one per line, e.g. "1. Preheat oven to 375F."]

NOTES:
[any useful tips or notes, or leave blank]

Webpage text:
${pageText}`

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (aiResp.ok) {
      const aiData = await aiResp.json()
      const text = aiData.content?.[0]?.text || ''

      const nameMatch = text.match(/^NAME:\s*(.+)/im)
      const ingMatch = text.match(/INGREDIENTS:\s*([\s\S]*?)(?=INSTRUCTIONS:|NOTES:|$)/i)
      const instMatch = text.match(/INSTRUCTIONS:\s*([\s\S]*?)(?=NOTES:|$)/i)
      const notesMatch = text.match(/NOTES:\s*([\s\S]*?)$/i)

      const name = (nameMatch?.[1] || fallbackName).trim()
      const ingredients = (ingMatch?.[1] || '').trim()
      const instructions = (instMatch?.[1] || '').trim()
      const notes = (notesMatch?.[1] || '').trim()

      if (name && (ingredients || instructions)) {
        return res.status(200).json({ name, ingredients, instructions, notes, url, source })
      }
    }
  } catch (e) {}

  // Final fallback — name only
  return res.status(200).json({
    name: fallbackName, ingredients: '', instructions: '', url, source,
    partial: true,
    warning: 'Could not automatically extract this recipe — please paste the ingredients and instructions manually.'
  })
}
