// api/scan.js — scans a recipe image using Claude vision

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { image, mediaType } = req.body
  if (!image) return res.status(400).json({ error: 'Missing image data' })

  const apiKey = process.env.miseenplace_apikey
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' })

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: image
              }
            },
            {
              type: 'text',
              text: `Extract the recipe from this cookbook or recipe page photo. Return ONLY this exact structure with no extra commentary:

NAME: [recipe name]

INGREDIENTS:
[one ingredient per line with exact amounts, e.g. "2 cups flour"]

INSTRUCTIONS:
[numbered steps, one per line, e.g. "1. Preheat oven to 375F."]

NOTES:
[any tips, variations, or serving suggestions — leave blank if none]`
            }
          ]
        }]
      })
    })

    if (!resp.ok) {
      const err = await resp.text()
      return res.status(500).json({ error: 'AI error: ' + err })
    }

    const data = await resp.json()
    const text = data.content?.[0]?.text || ''

    const nameMatch = text.match(/^NAME:\s*(.+)/im)
    const ingMatch = text.match(/INGREDIENTS:\s*([\s\S]*?)(?=INSTRUCTIONS:|NOTES:|$)/i)
    const instMatch = text.match(/INSTRUCTIONS:\s*([\s\S]*?)(?=NOTES:|$)/i)
    const notesMatch = text.match(/NOTES:\s*([\s\S]*?)$/i)

    const name = (nameMatch?.[1] || '').trim()
    const ingredients = (ingMatch?.[1] || '').trim()
    const instructions = (instMatch?.[1] || '').trim()
    const notes = (notesMatch?.[1] || '').trim()

    if (!name && !ingredients) {
      return res.status(422).json({ error: 'Could not find a recipe in this image. Try a clearer photo.' })
    }

    return res.status(200).json({ name, ingredients, instructions, notes })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
