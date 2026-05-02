// api/shortcut.js — Siri Shortcuts integration
// Supports: add to list, add to pantry, log meal, get list

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY

  // User ID from header or query param
  const userId = req.headers['x-user-id'] || req.query.uid
  if (!userId) return res.status(400).json({ error: 'Missing user ID. Include x-user-id header or ?uid= param.' })

  async function sb(table, method, body, query) {
    const url = `${SUPABASE_URL}/rest/v1/${table}${query || ''}`
    const isWrite = method !== 'GET'
    const r = await fetch(url, {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        ...(isWrite ? { 'Content-Type': 'application/json', 'Prefer': 'return=representation' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await r.text()
    return text ? JSON.parse(text) : []
  }

  // Parse action from body or query
  const body = req.method === 'POST' ? req.body : {}
  const action = body.action || req.query.action
  const item = body.item || req.query.item
  const calories = body.calories ? parseInt(body.calories) : null

  if (!action) {
    return res.status(400).json({
      error: 'Missing action',
      supported_actions: ['add_to_list', 'add_to_pantry', 'log_meal', 'get_list', 'get_pantry']
    })
  }

  try {
    // ADD TO SHOPPING LIST
    if (action === 'add_to_list') {
      if (!item) return res.status(400).json({ error: 'Missing item name' })
      const items = item.split(',').map(s => s.trim()).filter(Boolean)
      const added = []
      for (const name of items) {
        const data = await sb('shop_list', 'POST', { user_id: userId, name, from_recipe: 'Siri', have: false })
        if (data?.[0]) added.push(name)
      }
      return res.status(200).json({
        success: true,
        message: added.length === 1 ? `Added ${added[0]} to your shopping list.` : `Added ${added.join(', ')} to your shopping list.`,
        added
      })
    }

    // ADD TO PANTRY
    if (action === 'add_to_pantry') {
      if (!item) return res.status(400).json({ error: 'Missing item name' })
      const items = item.split(',').map(s => s.trim()).filter(Boolean)
      const added = []
      for (const name of items) {
        const data = await sb('pantry', 'POST', { user_id: userId, name, qty: '' })
        if (data?.[0]) added.push(name)
      }
      return res.status(200).json({
        success: true,
        message: added.length === 1 ? `Added ${added[0]} to your pantry.` : `Added ${added.join(', ')} to your pantry.`,
        added
      })
    }

    // LOG A MEAL
    if (action === 'log_meal') {
      if (!item) return res.status(400).json({ error: 'Missing food name' })
      const data = await sb('food_log', 'POST', {
        user_id: userId,
        food: item,
        calories: calories || 0,
        logged_at: new Date().toISOString()
      })
      const cal = calories ? ` (${calories} calories)` : ' (no calories — add them in the app)'
      return res.status(200).json({
        success: true,
        message: `Logged ${item}${cal}.`,
        entry: data?.[0]
      })
    }

    // GET SHOPPING LIST
    if (action === 'get_list') {
      const data = await sb('shop_list', 'GET', null, `?user_id=eq.${userId}&have=eq.false&order=name`)
      if (!data.length) return res.status(200).json({ success: true, message: 'Your shopping list is empty.', items: [] })
      const names = data.map(i => i.name)
      return res.status(200).json({
        success: true,
        message: `You have ${names.length} item${names.length !== 1 ? 's' : ''} on your list: ${names.join(', ')}.`,
        items: names
      })
    }

    // GET PANTRY
    if (action === 'get_pantry') {
      const data = await sb('pantry', 'GET', null, `?user_id=eq.${userId}&order=name`)
      if (!data.length) return res.status(200).json({ success: true, message: 'Your pantry is empty.', items: [] })
      const names = data.map(i => i.name + (i.qty ? ` (${i.qty})` : ''))
      return res.status(200).json({
        success: true,
        message: `Your pantry has ${data.length} item${data.length !== 1 ? 's' : ''}: ${names.join(', ')}.`,
        items: names
      })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
