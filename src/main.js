import * as db from './db.js'
import { getUserId } from './supabase.js'

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tab: 'recipes',
  recipes: [], pantry: [], shopList: [], log: [],
  goals: { calories: 2000, goal: 'maintain' },
  loading: true,
  showGoals: false,
  showSync: false,
  expandedRecipe: null,
  activeCategory: 'All',
  allTags: [],
  activeTagFilter: null,
  activeTagFilterNs: null,
  showTagFilter: false,
  tagPickerOpen: null,
  tagPickerPos: null,
  newRecipeTags: [],
  newRecipeTagPickerOpen: false,
  shareLoading: false,
  sharedRecipe: null,
  clipboardBanner: null,
  _lastClipboardUrl: null,
  clipUrlModal: false,
  editingPantryId: null,
  editingShopId: null,
  weekOffset: 0,        // 0 = current week, 1 = next week, -1 = last week
  historyLog: [],       // full log history
  historyOffset: 0,     // week offset for history view
  agentProfile: null,   // computed behavioral profile
  chatMessages: [],     // in-app chat history
  chatLoading: false,   // waiting for AI response
  mealPlan: [],         // loaded meal plan entries
  calendarSlot: null,   // { date, slot } when picker is open
  calendarTagFilter: null,
  addToWeekModal: null,
  logSearch: '',        // search query in log tab
  logTagFilter: null,
  logSearchFocused: false,
  logRecipeResults: [], // recipe search results in log
  editingNotes: null,
  editingRecipeId: null,
  shopReview: null,
  pasteModal: false,
  addRecipeModal: false,
  logModal: null,
}

const GOAL_PRESETS = {
  lose:     { calories: 1600, label: 'Lose Weight' },
  maintain: { calories: 2000, label: 'Maintain' },
  gain:     { calories: 2500, label: 'Build Muscle' },
}

// ── INIT ──────────────────────────────────────────────────────────────────────


async function sendChatMessage(userMessage) {
  if (!userMessage.trim() || state.chatLoading) return

  // Add user message
  state.chatMessages.push({ role: 'user', content: userMessage })
  state.chatLoading = true
  render()

  // Scroll to bottom
  setTimeout(() => {
    const el = document.getElementById('chat-messages')
    if (el) el.scrollTop = el.scrollHeight
  }, 50)

  try {
    // Build system context
    const context = buildClaudeContext()
    const agentCtx = buildAgentContext(state.agentProfile)
    const systemPrompt = 'You are a personal food and meal planning coach for this user. You know their recipes, pantry, eating habits and goals intimately. Be warm, specific, and actionable. Reference their actual recipes and patterns by name when relevant. Keep responses concise and practical.' + context + agentCtx

    // Build message history for API
    const messages = state.chatMessages.map(m => ({ role: m.role, content: m.content }))

    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system: systemPrompt })
    })

    if (!resp.ok) throw new Error('API error ' + resp.status)
    const data = await resp.json()
    const reply = data.content?.[0]?.text || 'Sorry, I could not get a response.'

    state.chatMessages.push({ role: 'assistant', content: reply })
  } catch(e) {
    state.chatMessages.push({ role: 'assistant', content: '[!] ' + (e.message || 'Something went wrong. Please try again.') })
  }

  state.chatLoading = false
  render()
  setTimeout(() => {
    const el = document.getElementById('chat-messages')
    if (el) el.scrollTop = el.scrollHeight
  }, 50)
}

async function addTagToItem(name, namespace, itemId) {
  // Save tag to tag library
  const savedTag = await db.saveTag(name, namespace)
  if (savedTag && !state.allTags.find(t => t.name === name && t.namespace === namespace)) {
    state.allTags.push(savedTag)
  }

  if (namespace === 'recipe') {
    const r = state.recipes.find(x => String(x.id) === String(itemId))
    if (r && !(r.tags||[]).includes(name)) {
      r.tags = [...(r.tags||[]), name]
      await db.updateRecipeTags(r.id, r.tags)
    }
  } else if (namespace === 'location') {
    // Search both pantry and shop list — both use 'location' namespace
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p && !(p.tags||[]).includes(name)) {
      p.tags = [...(p.tags||[]), name]
      await db.updatePantryTags(p.id, p.tags)
    }
    const s = state.shopList.find(x => String(x.id) === String(itemId))
    if (s && !(s.tags||[]).includes(name)) {
      s.tags = [...(s.tags||[]), name]
      await db.updateShopItemTags(s.id, s.tags)
    }
  }
  render()
}

async function removeTagFromItem(name, namespace, itemId) {
  if (namespace === 'recipe') {
    const r = state.recipes.find(x => String(x.id) === String(itemId))
    if (r) { r.tags = (r.tags||[]).filter(t => t !== name); await db.updateRecipeTags(r.id, r.tags) }
  } else if (namespace === 'location') {
    // Search both pantry and shop list — both use 'location' namespace
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p) { p.tags = (p.tags||[]).filter(t => t !== name); await db.updatePantryTags(p.id, p.tags) }
    const s = state.shopList.find(x => String(x.id) === String(itemId))
    if (s) { s.tags = (s.tags||[]).filter(t => t !== name); await db.updateShopItemTags(s.id, s.tags) }
  }
  render()
}

async function init() {
  render()
  const weekDates = getWeekDates(0)
  const [recipes, pantry, shopList, log, goals, allTags, mealPlan, historyLog] = await Promise.all([
    db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals(), db.fetchTags(),
    db.fetchMealPlan(weekDates[0], weekDates[6]), db.fetchFullLog(90)
  ])
  state.allTags = allTags || []
  state.mealPlan = mealPlan || []
  state.historyLog = historyLog || []
  state.agentProfile = buildAgentProfile(state.historyLog, [])
  state.recipes  = recipes.map(normalizeRecipe)
  state.pantry   = pantry
  state.shopList = shopList.map(i => ({ ...i, fromRecipe: i.from_recipe }))
  state.log      = log
  if (goals) state.goals = { calories: goals.calories, goal: goals.goal_type }
  state.loading  = false
  render()
}

function normalizeRecipe(r) {
  return { ...r, cookingNotes: r.cooking_notes || '', clippedFrom: r.clipped_from || '', category: r.category || '', tags: r.tags || [], text: [r.ingredients, r.instructions].filter(Boolean).join('\n\n') }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function todayCalories() { return state.log.reduce((s,e) => s + (e.calories||0), 0) }


// Strip measurements from ingredient lines for pantry matching
function stripMeasurements(line) {
  return line.toLowerCase()
    .replace(/[\d¼½¾⅓⅔⅛⅜⅝⅞]+\/?\ d*\s*/g, '')
    .replace(/\b(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|grams?|kg|ml|liters?|pints?|quarts?|cans?|jars?|packages?|bunches?|heads?|cloves?|slices?|pieces?|large|medium|small|fresh|dried|chopped|minced|diced|sliced|about|to\s+\d+)\b/gi, '')
    .replace(/[,.\-–()]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Parse ingredient line to clean shopping list format
function parseIngredientLine(line) {
  let s = line
  // Remove parenthetical notes first
  s = s.replace(/\([^)]*\)/g, ' ')
  // Remove everything after a comma
  s = s.replace(/,.*$/, '')
  s = s.replace(/\s+/g, ' ').trim()

  const unitMap = {'tablespoons?':'tbsp','tbsp':'tbsp','teaspoons?':'tsp','tsp':'tsp','cups?':'cup','ounces?':'oz','oz':'oz','pounds?':'lb','lbs?':'lb','grams?':'g','kg':'kg','ml':'ml','cans?':'can','jars?':'jar','packages?':'pkg','bunches?':'bunch','heads?':'head','cloves?':'clove','slices?':'slice'}
  const unitPattern = Object.keys(unitMap).join('|')
  const qtyRe = new RegExp('^\\s*(\\d+(?:[./]\\d+)?)\\s*(?:('+unitPattern+')\\s+)?','i')

  // Extract leading quantity FIRST
  let qty = ''
  const m = s.match(qtyRe)
  if (m) {
    const num = m[1], rawUnit = m[2]
    const unit = rawUnit ? (unitMap[Object.keys(unitMap).find(k => new RegExp('^'+k+'$','i').test(rawUnit))] || rawUnit) : ''
    qty = unit ? num+unit : num
    s = s.replace(qtyRe, '')
  }

  // NOW strip prep words and size adjectives from what remains
  s = s.replace(/^(chopped|sliced|diced|minced|grated|shredded|peeled|trimmed|divided|softened|melted|beaten|packed|heaping|fresh|dried|frozen|raw|cooked|whole|boneless|skinless|canned|unsalted|salted|large|medium|small)\s+/gi, '')
  s = s.replace(/\s+(chopped|sliced|diced|minced|grated|shredded|peeled|trimmed|divided|softened|melted|beaten|room temperature|at room temp|packed|heaping|to taste|or more|such as).*/i, '')
  s = s.replace(/\b(large|medium|small|fresh|dried|frozen|raw|cooked|whole|boneless|skinless|canned|unsalted|salted)\b/gi, '')
  s = s.replace(/\s+/g, ' ').trim()

  const name = s.replace(/\b\w/g, c => c.toUpperCase())
  return qty ? name + ', ' + qty : name
}

function buildClaudeContext() {
  const recipeList = state.recipes.length === 0 ? "No recipes saved yet."
    : state.recipes.map((r,i) => (i+1) + ". " + r.name + "\nINGREDIENTS:\n" + (r.ingredients||"") + "\nINSTRUCTIONS:\n" + (r.instructions||r.text||"") + (r.cookingNotes ? "\nMY NOTES: " + r.cookingNotes : "")).join("\n\n")
  const pantryList = state.pantry.length === 0 ? "Empty."
    : state.pantry.map(p => p.name + (p.qty ? " (" + p.qty + ")" : "")).join(", ")
  const logList = state.log.length === 0 ? "Nothing logged." : state.log.map(e => "- " + e.food + ": " + e.calories + " cal").join("\n")

  // Build history summary from historyLog
  let historySummary = "No history yet."
  if (state.historyLog && state.historyLog.length > 0) {
    const byDate = {}
    state.historyLog.forEach(e => {
      const d = (e.logged_at || "").slice(0, 10)
      if (!byDate[d]) byDate[d] = []
      byDate[d].push(e)
    })
    const dates = Object.keys(byDate).sort().reverse()
    const dailyCals = dates.map(d => byDate[d].reduce((s, e) => s + (e.calories || 0), 0))
    const avgCals = Math.round(dailyCals.reduce((a, b) => a + b, 0) / dailyCals.length)
    const foodCounts = {}
    state.historyLog.forEach(e => { foodCounts[e.food] = (foodCounts[e.food] || 0) + 1 })
    const topFoods = Object.entries(foodCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => f + " (" + n + "x)").join(", ")
    const recentDays = dates.slice(0, 7).map(d => {
      const entries = byDate[d].map(e => e.food + (e.calories ? " " + e.calories + "cal" : "")).join(", ")
      const total = byDate[d].reduce((s, e) => s + (e.calories || 0), 0)
      return d + ": " + entries + " | Total: " + total + " cal"
    }).join("\n")
    historySummary = "Days tracked: " + dates.length + "\nAvg daily calories: " + avgCals + "\nMost frequently eaten: " + topFoods + "\n\nLAST 7 DAYS:\n" + recentDays
  }

  const goalLabel = (GOAL_PRESETS[state.goals.goal] && GOAL_PRESETS[state.goals.goal].label) || state.goals.goal
  return "My Mise en Place Data:\n\n" +
    "GOALS: " + state.goals.calories + " cal/day | Protein " + state.goals.protein + "g | Carbs " + state.goals.carbs + "g | Fat " + state.goals.fat + "g | Goal: " + goalLabel + "\n\n" +
    "TODAY'S LOG:\n" + logList + "\nTotal: " + todayCalories() + " / " + state.goals.calories + " cal\n\n" +
    "EATING HISTORY (last 90 days):\n" + historySummary + "\n\n" +
    "PANTRY: " + pantryList + "\n\n" +
    "SAVED RECIPES (" + state.recipes.length + "):\n" + recipeList
}

function openClaude(prompt) {
  state.tab = 'chat'
  sendChatMessage(prompt || 'Help me with my meal planning this week.')
  render()
}

function formatRecipeText(text) {
  if (!text) return ''
  return text.split('\n').map(line => {
    line = line.trim()
    if (!line) return ''
    if (line.startsWith('•') || /^\d+\./.test(line)) return `<div class="rt-item">${esc(line)}</div>`
    return `<div class="rt-line">${esc(line)}</div>`
  }).join('')
}

function formatText(text) {
  return text.split('\n').map(line => {
    if (/^#{1,3}\s/.test(line)) return `<div class="fmt-h3">${line.replace(/^#+\s/,'')}</div>`
    if (line.startsWith('**') && line.endsWith('**')) return `<div class="fmt-h3">${line.slice(2,-2)}</div>`
    if (line.startsWith('- ') || line.startsWith('• ')) return `<div class="fmt-li">${line.slice(2)}</div>`
    if (/^\d+\.\s/.test(line)) return `<div class="fmt-li">${line.replace(/^\d+\.\s/,'')}</div>`
    if (!line.trim()) return '<div style="height:5px"></div>'
    return `<div class="fmt-p">${line}</div>`
  }).join('')
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app')
  const cals = todayCalories()
  const calPct = Math.min((cals / state.goals.calories) * 100, 100)
  const calCls = calPct > 100 ? 'over' : calPct > 80 ? 'warn' : ''
  const needCount = state.shopList.filter(i => !i.have).length

  const clipBanner = state.clipboardBanner ? '<div class="clipboard-banner" id="clipboard-banner"><div class="clipboard-banner-text">Recipe link detected - clip it?</div><div class="clipboard-banner-btns"><button class="clipboard-banner-yes" id="clipboard-yes">Clip it</button><button class="clipboard-banner-no" id="clipboard-no">x</button></div></div>' : ''
  app.innerHTML = `
    <div class="layout">
      ${clipBanner}
      <!-- HEADER -->
      <div class="header">
        <div class="header-title"><em>Mise en Place</em></div>
        <div class="header-right">
          ${cals > 0 ? '<div class="header-cal">Today: ' + cals + ' cal</div>' : ''}
        <button class="icon-btn" id="clip-url-btn">Clip</button><button class="icon-btn" id="paste-btn">Paste</button>
          <button class="icon-btn" id="sync-toggle">&#128279; Sync</button>
          <button class="icon-btn ${state.showGoals?'active':''}" id="goals-toggle">&#9881; Goals</button>
        </div>
      </div>

      <!-- GOALS PANEL -->
      ${state.showGoals ? `
      <div class="goals-panel">
        <div class="goals-title">Your Goals</div>
        <div class="goal-presets">
          ${Object.entries(GOAL_PRESETS).map(([k,p]) => `
            <button class="preset-btn ${state.goals.goal===k?'active':''}" data-preset="${k}">${p.label}</button>
          `).join('')}
        </div>
        <div class="goals-grid">
          ${['calories','protein','carbs','fat'].map(f => `
            <div class="goal-field">
              <label>${f}${f!=='calories'?' (g)':' (kcal)'}</label>
              <input type="number" data-goal="${f}" value="${state.goals[f]}" />
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- SYNC PANEL -->
      ${state.showSync ? `
      <div class="sync-panel">
        <div class="sync-title">Sync Devices</div>
        <div class="sync-hint">Use the same Account ID on all your devices.</div>
        <div class="sync-id-box">
          <div class="sync-id-label">Your Account ID</div>
          <div class="sync-id-value" id="sync-id-display">${getUserId()}</div>
          <button class="sync-copy-btn" id="sync-copy-btn">Copy</button>
        </div>
        <div class="sync-id-box" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div class="sync-id-label">Add to iPhone Home Screen</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5);line-height:1.5">Open this link in Safari, then Share -> Add to Home Screen. Your Account ID saves automatically.</div>
          <button class="sync-copy-btn" id="sync-bookmark-btn">Copy Bookmark Link</button>
        </div>
        <div class="sync-switch-box">
          <div class="sync-id-label">Switch Account ID</div>
          <div class="sync-input-row">
            <input id="sync-input" placeholder="Paste Account ID here..." />
            <button class="add-btn" id="sync-switch-btn">Switch</button>
          </div>
          <div class="sync-warning">[!] This will replace your current data with that account's data.</div>
        </div>
      </div>` : ""}

      <!-- TABS -->
      <div class="tabs">
        <div class="tab ${state.tab==='recipes'?'active':''}" data-tab="recipes">&#127859; Recipes${state.recipes.length>0?'<span class="tab-badge">'+state.recipes.length+'</span>':''}</div>
        <div class="tab ${state.tab==='pantry'?'active':''}" data-tab="pantry">🧺 Pantry${state.pantry.length>0?'<span class="tab-badge">'+state.pantry.length+'</span>':''}</div>
        <div class="tab ${state.tab==='shop'?'active':''}" data-tab="shop">🛒 List${needCount>0?'<span class="tab-badge">'+needCount+'</span>':''}</div>
        <div class="tab ${state.tab==='log'?'active':''}" data-tab="log">&#128221; Log</div>
        <div class="tab ${state.tab==='calendar'?'active':''}" data-tab="calendar">📅 Week</div>
        <div class="tab ${state.tab==='tags'?'active':''}" data-tab="tags">🏷 Tags</div>
        <div class="tab ${state.tab==='chat'?'active':''}" data-tab="chat">💬 AI</div>
      </div>



      <!-- CONTENT -->
      <div class="content">
        ${state.loading ? '<div class="loading"><div class="spinner"></div><div>Loading your data…</div></div>' : ''}
        ${!state.loading && state.tab === 'recipes' ? renderRecipes() : ''}
        ${!state.loading && state.tab === 'pantry'  ? renderPantry()  : ''}
        ${!state.loading && state.tab === 'shop'    ? renderShop()    : ''}
        ${!state.loading && state.tab === 'log'     ? renderLog()     : ''}
        ${!state.loading && state.tab === 'calendar' ? renderCalendar() : ''}
        ${!state.loading && state.tab === 'history'  ? renderHistory()  : ''}
        ${!state.loading && state.tab === 'tags'    ? renderTags()    : ''}
        ${!state.loading && state.tab === 'chat'    ? renderChat()    : ''}
      </div>

      <!-- MODALS -->
      ${state.pasteModal    ? renderPasteModal()    : ''}
      ${state.clipUrlModal  ? renderClipUrlModal()  : ''}
      ${state.shopReview    ? renderShopReview()    : ''}
      ${state.addToWeekModal ? renderAddToWeekModal() : ''}
      ${state.logModal      ? renderLogModal()      : ''}
    </div>
  `
  bindEvents()
  // Position active tag picker near its button
  const activePicker = document.getElementById('tag-picker-popover')
  if (activePicker && state.tagPickerPos) {
    activePicker.style.top = state.tagPickerPos.top + 'px'
    activePicker.style.left = Math.min(state.tagPickerPos.left, window.innerWidth - 220) + 'px'
  }
}

// ── TAB RENDERS ───────────────────────────────────────────────────────────────
const CATEGORIES = ['Mains','Dressings & Sauces','Sides','Breakfast','Soups & Stews','Meal Prep','Desserts','Snacks']

function categoryOptions(selected) {
  return CATEGORIES.map(c => {
    const sel = c === selected ? ' selected' : ''
    return '<option value="' + esc(c) + '"' + sel + '>' + esc(c) + '</option>'
  }).join('')
}


// Tag helpers
function tagPickerStyle() {
  const pos = state.tagPickerPos
  if (!pos) return 'top:0;left:0'
  return 'top:' + pos.top + 'px;left:' + pos.left + 'px'
}

function getTagsForNamespace(namespace) {
  return state.allTags.filter(t => t.namespace === namespace)
}
function tagsForRecipe(r) { return r.tags || [] }
function tagsForPantry(p) { return p.tags || [] }
function tagsForShop(s) { return s.tags || [] }

function renderTagChips(tags, itemId, namespace, removeEvent) {
  if (!tags || !tags.length) return ''
  return tags.map(tag =>
    '<span class="tag-chip">' + esc(tag) +
    '<button class="tag-chip-remove" data-remove-tag="' + esc(tag) + '" data-tag-item="' + itemId + '" data-tag-ns="' + namespace + '">×</button>' +
    '</span>'
  ).join('')
}

function renderTagInput(itemId, namespace, currentTags) {
  const existing = getTagsForNamespace(namespace)
  const suggestions = existing.filter(t => !(currentTags||[]).includes(t.name))
  return '<div class="tag-input-wrap">' +
    '<input class="tag-input" id="tag-input-' + itemId + '" data-tag-item="' + itemId + '" data-tag-ns="' + namespace + '" placeholder="Add tag..." autocomplete="off" />' +
    (suggestions.length ? '<div class="tag-suggestions" id="tag-sugg-' + itemId + '">' +
      suggestions.map(t => '<button class="tag-suggestion" data-sugg-tag="' + esc(t.name) + '" data-tag-item="' + itemId + '" data-tag-ns="' + namespace + '">' + esc(t.name) + '</button>').join('') +
    '</div>' : '') +
  '</div>'
}

function renderTagFilterChips(namespace) {
  const tags = getTagsForNamespace(namespace)
  if (!tags.length) return ''
  const isOpen = state.showTagFilter && state.activeTagFilterNs === namespace
  const activeTag = state.activeTagFilterNs === namespace ? state.activeTagFilter : null
  return '<div class="tag-filter-wrap">' +
    '<button class="tag-filter-toggle ' + (activeTag ? 'has-filter' : '') + '" data-filter-toggle="' + namespace + '">' +
      (activeTag ? '🏷 ' + activeTag : '🏷 Filter by tag') +
      (isOpen ? ' ▲' : ' ▼') +
    '</button>' +
    (isOpen ? '<div class="tag-filter-row">' +
      '<button class="tag-filter-chip ' + (!activeTag ? 'active' : '') + '" data-filter-tag="" data-filter-ns="' + namespace + '">All</button>' +
      tags.map(t => '<button class="tag-filter-chip ' + (activeTag===t.name ? 'active' : '') + '" data-filter-tag="' + esc(t.name) + '" data-filter-ns="' + namespace + '">' + esc(t.name) + '</button>').join('') +
    '</div>' : '') +
  '</div>'
}

function renderRecipeCard(r) {
  const isExpanded = state.expandedRecipe === r.id
  const header = '<div class="recipe-card" data-rid="' + r.id + '">' +
    '<div class="recipe-card-header">' +
      '<div>' +
        '<div class="recipe-name">' + esc(r.name) + '</div>' +
        ((r.tags&&r.tags.length) ? '<div class="recipe-tags-preview">' + r.tags.map(t => '<span class="tag-chip-small">' + esc(t) + '</span>').join('') + '</div>' : '') +
        (r.notes ? '<div class="recipe-meta">' + esc(r.notes) + '</div>' : '') +
        (r.clippedFrom ? '<div class="recipe-meta">&#128206; ' + esc((() => { try { return new URL(r.clippedFrom).hostname.replace('www.','') } catch(e) { return '' } })()) + '</div>' : '') +
      '</div>' +
      '<div class="chevron ' + (isExpanded ? 'open' : '') + '">▼</div>' +
    '</div>'

  if (!isExpanded) return header + '</div>'

  const notesSection = state.editingNotes === r.id
    ? '<textarea class="notes-textarea" id="notes-ta-' + r.id + '" placeholder="What worked, what to change, substitutions...">' + esc(r.cookingNotes||'') + '</textarea>' +
      '<button class="notes-save-btn" data-notes-save="' + r.id + '">Save Notes</button>'
    : '<div class="notes-display ' + (!r.cookingNotes ? 'notes-empty' : '') + '">' + (r.cookingNotes ? esc(r.cookingNotes) : 'No notes yet!') + '</div>'

  const tagChips = (r.tags||[]).map(t =>
    '<span class="tag-chip">' + esc(t) +
    '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe">×</button>' +
    '</span>'
  ).join('')
  const tagPickerBtn = '<button class="tag-picker-btn" data-picker-id="' + r.id + '" data-picker-ns="recipe">+ Tag</button>'
  const isPickerOpen = state.tagPickerOpen === r.id + '-recipe'
  const mealTags = getTagsForNamespace('recipe')
  const tagPicker = isPickerOpen ? (
    '<div class="tag-picker-popover" id="tag-picker-popover" style="' + tagPickerStyle() + '">' +
    mealTags.map(t => {
      const checked = (r.tags||[]).includes(t.name)
      return '<label class="tag-picker-option">' +
        '<input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe" ' + (checked?'checked':'') + ' />' +
        esc(t.name) + '</label>'
    }).join('') +
    '<div class="tag-picker-new">' +
      '<input class="tag-picker-input" id="new-tag-' + r.id + '-recipe" placeholder="New tag..." />' +
      '<button class="tag-picker-add" data-new-tag-item="' + r.id + '" data-new-tag-ns="recipe">Add</button>' +
    '</div>' +
    '</div>'
  ) : ''

  const isEditingRecipe = state.editingRecipeId === r.id
  const body = '<div class="recipe-body">' +
    (r.clippedFrom ? '<div class="recipe-link"><a href="' + esc(r.clippedFrom) + '" target="_blank">&#128279; View original</a></div>' : '') +
    '<div class="recipe-section-label cooking-notes-label">Ingredients' +
      '<button class="notes-edit-btn" data-recipe-edit="' + r.id + '">' + (isEditingRecipe ? 'Done' : 'Edit') + '</button>' +
    '</div>' +
    (isEditingRecipe ?
      '<textarea class="notes-textarea" id="edit-ingredients-' + r.id + '" style="min-height:120px">' + esc(r.ingredients || '') + '</textarea>' +
      '<button class="notes-save-btn" data-recipe-save="' + r.id + '">Save Changes</button>'
    :
      (r.ingredients ? '<div class="recipe-text">' + formatRecipeText(r.ingredients) + '</div>' : '<div class="recipe-text" style="color:var(--ink4);font-style:italic">No ingredients yet — tap Edit to add</div>')
    ) +
    '<div class="recipe-section-label">Instructions</div>' +
    (isEditingRecipe ?
      '<textarea class="notes-textarea" id="edit-instructions-' + r.id + '" style="min-height:120px">' + esc(r.instructions || '') + '</textarea>'
    :
      (r.instructions ? '<div class="recipe-text">' + formatRecipeText(r.instructions) + '</div>' : (r.text ? '<div class="recipe-text">' + formatRecipeText(r.text) + '</div>' : ''))
    ) +
    '<div class="recipe-section-label cooking-notes-label">My Cooking Notes' +
      '<button class="notes-edit-btn" data-notes-edit="' + r.id + '">' + (state.editingNotes===r.id?'Done':'Edit') + '</button>' +
    '</div>' +
    notesSection +
    '<div class="tag-row">' + tagChips + tagPickerBtn + tagPicker + '</div>' +
    '<div class="recipe-actions">' +
      '<button class="ra-btn ra-shop" data-shop="' + r.id + '">Add to list</button>' +
      '<button class="ra-btn ra-log" data-log-recipe="' + r.id + '">Log meal</button>' +
      '<button class="ra-btn ra-log" data-add-to-week="' + r.id + '" data-add-name="' + esc(r.name) + '">+ Week</button>' +
      '<button class="ra-btn ra-ask" data-ask="' + r.id + '">Ask AI</button>' +
      '<button class="ra-btn ra-del" data-del="' + r.id + '">Del</button>' +
    '</div>' +
  '</div>'

  return header + body + '</div>'
}

function renderRecipes() {
  const filtered = (state.activeTagFilter && state.activeTagFilterNs === 'recipe') ? state.recipes.filter(r => (r.tags||[]).includes(state.activeTagFilter)) : state.recipes
  return `
    <div class="tab-content">
      <div class="section-header">
        <div class="section-title">My Recipe Box</div>
        <button class="add-btn" id="add-recipe-btn">+ Add Recipe</button>
      </div>
      ${state.allTags.some(t => t.namespace === 'recipe') ? renderTagFilterChips('recipe', 'Meal') : ''}
      ${state.addRecipeModal ? `
        <div class="recipe-add-box">
          <input id="r-name" placeholder="Recipe name" />
          <div class="clip-field-label">Ingredients</div>
          <textarea id="r-ingredients" placeholder="One ingredient per line..."></textarea>
          <div class="clip-field-label">Instructions</div>
          <textarea id="r-instructions" placeholder="Step by step..."></textarea>
          <div class="clip-field-label">Category</div>
          <select id="r-category" class="category-select">
            <option value="">No category</option>
            ${categoryOptions('')}
          </select>
          <div class="add-row" style="margin-top:8px">
            <input id="r-notes" placeholder="Note (optional)" style="flex:1" />
            <button class="add-btn" id="r-save-btn">Save</button>
            <button class="clip-cancel-btn" id="r-cancel-btn">Cancel</button>
          </div>
        </div>
      ` : ''}
      ${filtered.length === 0 && !state.addRecipeModal ? `
        <div class="empty-state">${state.activeCategory !== 'All' ? `No ${state.activeCategory} recipes yet.` : 'No recipes yet.<br>Add one above or use the Chrome extension<br>to clip from any recipe website!'} 🥗</div>
      ` : filtered.map(r => renderRecipeCard(r)).join('')}
    </div>`
}

function renderPantry() {
  const activeTag = state.activeTagFilterNs === 'location' ? state.activeTagFilter : null
  const filtered = state.pantry.filter(item => !activeTag || (item.tags||[]).includes(activeTag))
  return '<div class="tab-content">' +
    '<div class="section-title">My Pantry</div>' +
    (state.allTags.some(t => t.namespace === 'location') ? renderTagFilterChips('location', 'Pantry') : '') +
    '<div class="pantry-hint">Add items with quantities - tap name to edit, or use Move to List.</div>' +
    '<div class="pantry-add-box"><div class="pantry-add-row">' +
      '<input id="pantry-name" placeholder="Item name" style="flex:2" />' +
      '<input id="pantry-qty" placeholder="Qty (2 cans)" style="flex:1" />' +
      '<button class="add-btn" id="pantry-add-btn">+ Add</button>' +
    '</div>' +
    (getTagsForNamespace('location').length > 0 ?
      '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' +
      '<span style="font-size:10px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Tag:</span>' +
      getTagsForNamespace('location').map(t =>
        '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="pantry-new-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--forest)" />' +
        esc(t.name) + '</label>'
      ).join('') +
      '</div>'
    : '') +
    '</div>' +
    (state.pantry.length === 0 ? '<div class="empty-state">Your pantry is empty.<br>Add staples you keep on hand!</div>' :
      '<div class="pantry-list">' +
      state.pantry.map(function(item) {
        const chips = (item.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + item.id + '" data-tag-ns="location">x</button></span>').join('')
        const pickerId = item.id + '-location'
        const isOpen = state.tagPickerOpen === pickerId
        const pantryTags = getTagsForNamespace('location')
        const picker = isOpen ? ('<div class="tag-picker-popover" id="tag-picker-popover" style="' + tagPickerStyle() + '">' + pantryTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + item.id + '" data-tag-ns="location" ' + ((item.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + item.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + item.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
        const isEditing = state.editingPantryId === String(item.id)
        return '<div class="pantry-row pantry-row-wrap">' +
          '<div class="pantry-row-main">' +
          (isEditing ?
            '<input class="pantry-edit-name" data-edit-pantry-name="' + item.id + '" value="' + esc(item.name) + '" style="flex:2;padding:5px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-size:13px;font-family:inherit" />' +
            '<input class="pantry-qty-input" data-qty-id="' + item.id + '" value="' + esc(item.qty||'')+'" placeholder="qty" />' +
            '<button class="add-btn" data-save-pantry="' + item.id + '" style="padding:5px 10px;font-size:11px">Save</button>'
          :
            '<div class="pantry-row-name" data-edit-pantry="' + item.id + '" style="flex:2;cursor:pointer" title="Tap to edit">' + esc(item.name) + '</div>' +
            '<input class="pantry-qty-input" data-qty-id="' + item.id + '" value="' + esc(item.qty||'')+'" placeholder="qty" />' +
            '<button class="ra-btn ra-shop" data-move-to-list="' + item.id + '" style="font-size:10px;padding:4px 8px">List</button>' +
            '<button class="remove-btn" data-pantry-del="' + item.id + '">x</button>'
          ) +
          '</div>' +
          '<div class="pantry-row-tags" style="position:relative">' + chips + '<button class="tag-picker-btn" data-picker-id="' + item.id + '" data-picker-ns="location">+ Tag</button>' + picker + '</div>' +
        '</div>'
      }).join('') +
      '</div>' +
      '<button class="clear-pantry-btn" id="clear-pantry">Clear all</button>'
    ) +
  '</div>'
}

function renderShopItems(items) {
  return items.map(function(i) {
    const chips = (i.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + i.id + '" data-tag-ns="location">x</button></span>').join('')
    const pickerId = i.id + '-location'
    const isOpen = state.tagPickerOpen === pickerId
    const storeTags = getTagsForNamespace('location')
    const picker = isOpen ? ('<div class="tag-picker-popover" id="tag-picker-popover" style="' + tagPickerStyle() + '">' + storeTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + i.id + '" data-tag-ns="location" ' + ((i.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + i.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + i.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
    const isEditingS = state.editingShopId === String(i.id)
    return '<div class="shop-row">' +
      '<div class="shop-check" data-check="' + i.id + '"></div>' +
      '<div class="shop-item-main">' +
      (isEditingS ?
        '<input class="shop-edit-name" data-edit-shop-name="' + i.id + '" value="' + esc(i.name) + '" style="width:100%;padding:5px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-size:13px;font-family:inherit;margin-bottom:4px" />' +
        '<button class="add-btn" data-save-shop="' + i.id + '" style="padding:4px 10px;font-size:11px">Save</button>'
      :
        '<div class="shop-item-name" data-edit-shop="' + i.id + '" style="cursor:pointer" title="Tap to edit">' + esc(i.name) + '</div>'
      ) +
      '<div class="shop-item-tags">' + chips + '<button class="tag-picker-btn" data-picker-id="' + i.id + '" data-picker-ns="location">+ Tag</button>' +
      '<button class="ra-btn ra-log" data-move-to-pantry="' + i.id + '" style="font-size:10px;padding:3px 8px">Pantry</button>' + picker + '</div>' +
      '</div>' +
      '<button class="remove-btn" data-shop-del="' + i.id + '">x</button>' +
    '</div>'
  }).join('')
}


function renderShop() {
  const activeTag = state.activeTagFilterNs === 'location' ? state.activeTagFilter : null
  const need = state.shopList.filter(i => !i.have && (!activeTag || (i.tags||[]).includes(activeTag)))

  return '<div class="tab-content">' +
    '<div class="shop-header">' +
      '<div class="section-title">Shopping List</div>' +
      (state.shopList.length > 0 ? '<div style="display:flex;gap:6px"><button class="icon-btn" id="shop-copy-btn">Copy</button><button class="clear-pantry-btn" id="shop-clear">Clear</button></div>' : '') +
    '</div>' +
    (state.shopList.length === 0 ? '<div class="empty-state">Your list is empty.<br>Open a recipe and tap <strong>Add to list</strong>!</div>' : '') +
    (state.allTags.some(t => t.namespace === 'location') ? renderTagFilterChips('location', 'Store') : '') +
    (need.length > 0 ?
      '<div class="shop-got-it-bar">' +
        '<div class="shop-got-it-text">' + need.length + ' item' + (need.length!==1?'s':'') + ' to buy</div>' +
        '<button class="shop-got-it-btn" id="shop-got-it">Got it all!</button>' +
      '</div>' +
      renderShopItems(need)
    : '') +
    '<div class="shop-add-row">' +
      '<input id="shop-manual-input" placeholder="Add item manually..." />' +
      '<button class="add-btn" id="shop-manual-add">+ Add</button>' +
    '</div>' +
    (getTagsForNamespace('location').length > 0 ?
      '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' +
      '<span style="font-size:10px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Tag:</span>' +
      getTagsForNamespace('location').map(t =>
        '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="shop-new-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--forest)" />' +
        esc(t.name) + '</label>'
      ).join('') +
      '</div>'
    : '') +
  '</div>'
}

function renderLog() {
  const cals = todayCalories()
  const goal = state.goals.calories
  const rem = goal - cals
  const search = state.logSearch || ''
  const logTagFilter = state.logTagFilter || null
  const recipeTags = getTagsForNamespace('recipe')
  const recipeResults = (search || logTagFilter)
    ? state.recipes.filter(r =>
        (!search || r.name.toLowerCase().includes(search.toLowerCase())) &&
        (!logTagFilter || (r.tags||[]).includes(logTagFilter))
      ).slice(0, 8)
    : []

  // Build week data from historyLog + today's log
  const now = new Date()
  const weekDays = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    weekDays.push(d.toISOString().slice(0, 10))
  }
  const today = now.toISOString().slice(0, 10)

  // Group history by date
  const byDate = {}
  ;(state.historyLog || []).forEach(e => {
    const d = new Date(e.logged_at).toLocaleDateString('sv') // sv locale gives YYYY-MM-DD in local time
    if (!byDate[d]) byDate[d] = []
    byDate[d].push(e)
  })
  // Today's log overrides history for today
  byDate[today] = state.log

  // Weekly totals
  const weeklyGoal = goal * 7
  const weeklyActual = weekDays.reduce((sum, d) => sum + (byDate[d] || []).reduce((s, e) => s + (e.calories || 0), 0), 0)
  const completeDays = weekDays.filter(d => d < today && (byDate[d] || []).length > 0).length
  const weeklyDiff = weeklyActual - (goal * (completeDays + 1)) // +1 for today partial
  const diffLabel = weeklyDiff === 0 ? 'On target'
    : weeklyDiff < 0 ? Math.abs(weeklyDiff) + ' cal deficit this week'
    : weeklyDiff + ' cal surplus this week'
  const diffColor = weeklyDiff < -100 ? 'var(--forest2)' : weeklyDiff > 100 ? 'var(--terra)' : 'var(--gold)'

  // Today entries
  const logEntries = state.log.length === 0
    ? '<div class="empty-state" style="padding:16px 0">Nothing logged yet today!</div>'
    : state.log.map(e =>
        '<div class="log-entry">' +
          '<div>' +
            '<div class="log-food">' + esc(e.food) + '</div>' +
            '<div class="log-cal ' + (e.calories === 0 ? 'log-cal-zero' : '') + '">' +
              (e.calories === 0
                ? '<button class="log-add-cals-btn" data-add-cals-id="' + e.id + '">+ Add calories</button>'
                : e.calories + ' kcal') +
            '</div>' +
          '</div>' +
          (e.recipe_id ? '<button class="log-recipe-link" data-go-recipe="' + e.recipe_id + '">recipe</button>' : '') +
          '<button class="remove-btn" data-log-del="' + e.id + '">x</button>' +
        '</div>'
      ).join('')

  // Weekly breakdown rows
  const weekRows = weekDays.map(d => {
    const entries = byDate[d] || []
    const dayCals = entries.reduce((s, e) => s + (e.calories || 0), 0)
    const isToday = d === today
    const diff = dayCals - goal
    const dayLabel = isToday ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const foods = entries.slice(0, 3).map(e => esc(e.food)).join(', ') + (entries.length > 3 ? ' +' + (entries.length - 3) + ' more' : '')
    const barPct = Math.min((dayCals / goal) * 100, 100)
    const barColor = diff > 200 ? 'var(--terra)' : diff > 0 ? 'var(--gold)' : 'var(--forest2)'
    return '<div style="padding:8px 0;border-bottom:1px solid var(--cream2)' + (isToday ? ';background:var(--sage4);border-radius:8px;padding:8px;margin:-2px 0' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
        '<span style="font-size:12px;font-weight:' + (isToday ? '700' : '500') + ';color:' + (isToday ? 'var(--forest)' : 'var(--ink)') + '">' + dayLabel + '</span>' +
        '<span style="font-size:12px;font-weight:600;color:var(--ink2)">' + (dayCals > 0 ? dayCals + ' cal' : '--') + '</span>' +
      '</div>' +
      (dayCals > 0 ? '<div style="height:3px;background:var(--cream3);border-radius:2px;margin-bottom:3px"><div style="height:100%;width:' + barPct + '%;background:' + barColor + ';border-radius:2px"></div></div>' : '') +
      (foods ? '<div style="font-size:10px;color:var(--ink3)">' + foods + '</div>' : '') +
    '</div>'
  }).join('')

  return '<div class="tab-content">' +
    // Today summary
    '<div class="log-total">' +
      '<div>' +
        '<div class="log-total-label">Today</div>' +
        '<div class="log-total-sub">' + (rem > 0 ? rem + ' remaining' : Math.abs(rem) + ' over goal') + '</div>' +
      '</div>' +
      '<div><span class="log-total-val">' + cals + '</span><span class="log-total-goal"> / ' + goal + '</span></div>' +
    '</div>' +
    // Weekly deficit/surplus banner
    '<div style="background:white;border:1.5px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">This week</span>' +
      '<span style="font-size:13px;font-weight:700;color:' + diffColor + '">' + diffLabel + '</span>' +
    '</div>' +
    // Log new food
    '<div class="log-search-wrap">' +
      '<input id="log-search" class="log-search-input" placeholder="Search recipes to log..." value="' + esc(search) + '" />' +
      (recipeResults.length ? '<div class="log-search-results">' +
        recipeResults.map(r =>
          '<button class="log-search-result" data-log-recipe="' + r.id + '" data-log-recipe-name="' + esc(r.name) + '">' + esc(r.name) + (r.tags&&r.tags.length ? ' <span style="font-size:10px;color:var(--ink3)">(' + r.tags.join(', ') + ')</span>' : '') + '</button>'
        ).join('') +
        '<button class="log-search-result" id="log-search-clear" style="color:var(--ink3);font-style:italic">Clear search</button>' +
      '</div>' : '') +
    '</div>' +
    (recipeTags.length > 0 ?
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">' +
        '<button class="tag-filter-chip ' + (!logTagFilter ? 'active' : '') + '" data-log-tag="">All</button>' +
        recipeTags.map(t => '<button class="tag-filter-chip ' + (logTagFilter === t.name ? 'active' : '') + '" data-log-tag="' + esc(t.name) + '">' + esc(t.name) + '</button>').join('') +
      '</div>'
    : '') +
    '<div class="log-add-row">' +
      '<input id="log-food" placeholder="Or type food name manually..." />' +
      '<input id="log-cals" type="number" placeholder="Cal" style="max-width:70px" />' +
      '<button class="add-btn" id="log-add-btn">+ Add</button>' +
    '</div>' +
    // Today's entries
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px">Today\'s meals</div>' +
    logEntries +
    // Weekly breakdown
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:16px 0 8px">This week</div>' +
    weekRows +
  '</div>'
}

function getWeekDates(offset) {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + (offset * 7))
  monday.setHours(0,0,0,0)
  return Array.from({length: 7}, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d.toISOString().slice(0,10)
  })
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0,10)
}

function getMealPlanEntries(date, slot) {
  return state.mealPlan.filter(e => e.date === date && e.meal_slot === slot)
}

const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack']
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']



// ── ANALYTICS & AGENT PROFILE ────────────────────────────────────────────────
function buildAgentProfile(fullLog, fullMealPlan) {
  if (!fullLog.length) return null

  // Group log by date
  const byDate = {}
  fullLog.forEach(e => {
    const date = e.logged_at?.slice(0,10)
    if (!date) return
    if (!byDate[date]) byDate[date] = []
    byDate[date].push(e)
  })

  const dates = Object.keys(byDate).sort()
  const totalDays = dates.length
  if (!totalDays) return null

  // Daily calorie averages
  const dailyCals = dates.map(d => byDate[d].reduce((s,e) => s + (e.calories||0), 0))
  const avgCals = Math.round(dailyCals.reduce((a,b) => a+b, 0) / totalDays)
  const daysOnTarget = dailyCals.filter(c => Math.abs(c - state.goals.calories) < 200).length
  const daysOver = dailyCals.filter(c => c > state.goals.calories + 200).length
  const daysUnder = dailyCals.filter(c => c < state.goals.calories - 300).length

  // Most logged foods
  const foodCount = {}
  fullLog.forEach(e => {
    const name = e.food?.split(' (')[0]?.toLowerCase() || ''
    if (name) foodCount[name] = (foodCount[name] || 0) + 1
  })
  const topFoods = Object.entries(foodCount)
    .sort((a,b) => b[1]-a[1])
    .slice(0,8)
    .map(([name, count]) => name + ' (' + count + 'x)')

  // Recipe frequency from log
  const recipeCount = {}
  fullLog.forEach(e => {
    if (e.food) {
      const name = e.food.split(' (')[0]
      recipeCount[name] = (recipeCount[name] || 0) + 1
    }
  })
  const topRecipes = Object.entries(recipeCount)
    .sort((a,b) => b[1]-a[1])
    .slice(0,5)
    .map(([name, count]) => name + ' (' + count + 'x)')

  // Recipes not cooked recently
  const recentFoods = new Set(fullLog.slice(0, 30).map(e => e.food?.split(' (')[0]?.toLowerCase()))
  const staleRecipes = state.recipes
    .filter(r => !recentFoods.has(r.name.toLowerCase()))
    .slice(0, 5)
    .map(r => r.name)

  // Day of week patterns
  const dayCalories = {0:[], 1:[], 2:[], 3:[], 4:[], 5:[], 6:[]}
  Object.entries(byDate).forEach(([date, entries]) => {
    const dow = new Date(date + 'T12:00:00').getDay()
    const total = entries.reduce((s,e) => s + (e.calories||0), 0)
    if (total > 0) dayCalories[dow].push(total)
  })
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const weakDays = Object.entries(dayCalories)
    .filter(([,cals]) => cals.length >= 2)
    .map(([dow, cals]) => ({ day: dayNames[dow], avg: Math.round(cals.reduce((a,b)=>a+b,0)/cals.length) }))
    .filter(d => d.avg < state.goals.calories - 400)
    .map(d => d.day + ' (avg ' + d.avg + ' cal)')

  return {
    totalDays, avgCals, daysOnTarget, daysOver, daysUnder,
    topFoods, topRecipes, staleRecipes, weakDays,
    goalCalories: state.goals.calories
  }
}

function buildAgentContext(profile) {
  if (!profile) return ''
  return '\n\nMY EATING PATTERNS (last ' + profile.totalDays + ' days):\n' +
    '- Average daily calories: ' + profile.avgCals + ' (goal: ' + profile.goalCalories + ')\n' +
    '- Days on target: ' + profile.daysOnTarget + '/' + profile.totalDays + '\n' +
    (profile.daysOver ? '- Days over goal: ' + profile.daysOver + '\n' : '') +
    (profile.daysUnder ? '- Days significantly under: ' + profile.daysUnder + '\n' : '') +
    (profile.weakDays.length ? '- Low calorie days: ' + profile.weakDays.join(', ') + '\n' : '') +
    (profile.topRecipes.length ? '- Most cooked: ' + profile.topRecipes.join(', ') + '\n' : '') +
    (profile.staleRecipes.length ? '- Not cooked recently: ' + profile.staleRecipes.join(', ') + '\n' : '') +
    (profile.topFoods.length ? '- Most logged foods: ' + profile.topFoods.join(', ') + '\n' : '')
}

function renderCalendar() {
  const dates = getWeekDates(state.weekOffset)
  const weekLabel = state.weekOffset === 0 ? 'This Week' : state.weekOffset === 1 ? 'Next Week' : state.weekOffset === -1 ? 'Last Week' : formatDate(dates[0]) + ' - ' + formatDate(dates[6])

  let html = '<div class="tab-content">'
  html += '<div class="cal-header">'
  html += '<button class="cal-nav" data-week-nav="-1">&lsaquo;</button>'
  html += '<div class="cal-week-label">' + weekLabel + '</div>'
  html += '<button class="cal-nav" data-week-nav="1">&rsaquo;</button>'
  html += '</div>'

  // Log today button if viewing current week
  if (state.weekOffset === 0) {
    const todayEntries = state.mealPlan.filter(e => e.date === new Date().toISOString().slice(0,10))
    if (todayEntries.length > 0) {
      html += "<button class='cal-log-today-btn' id='log-today-btn'>Log Today Meals</button>"
    }
  }

  // Day cards
  dates.forEach((date, idx) => {
    const today = isToday(date)
    html += '<div class="cal-day ' + (today ? 'cal-day-today' : '') + '">'
    html += '<div class="cal-day-header">'
    html += '<span class="cal-day-name">' + DAY_NAMES[idx] + '</span>'
    html += '<span class="cal-day-date">' + formatDate(date).split(', ')[1] + '</span>'
    html += '</div>'

    MEAL_SLOTS.forEach(slot => {
      const entries = getMealPlanEntries(date, slot)
      html += '<div class="cal-slot">'
      html += '<div class="cal-slot-label">' + slot + '</div>'

      entries.forEach(entry => {
        html += '<div class="cal-entry">'
        html += (entry.recipe_id
          ? '<button class="cal-entry-name" data-go-recipe="' + entry.recipe_id + '" style="background:none;border:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--forest);font-weight:600;font-size:13px;padding:0;text-decoration:underline dotted">' + esc(entry.recipe_name || 'Unnamed') + '</button>'
          : '<span class="cal-entry-name">' + esc(entry.recipe_name || 'Unnamed') + '</span>')
        html += '<div class="cal-entry-actions">'
        html += '<button class="cal-entry-log" data-log-plan="' + entry.id + '" data-plan-name="' + esc(entry.recipe_name) + '" data-plan-rid="' + (entry.recipe_id||'') + '">+ Log</button>'
        if (entry.recipe_id) html += '<button class="cal-entry-log" data-shop-plan="' + entry.recipe_id + '" style="background:var(--sage4);color:var(--forest)">+ List</button>'
        html += '<button class="cal-entry-del" data-del-plan="' + entry.id + '">&times;</button>'
        html += '</div>'
        html += '</div>'
      })

      html += '<button class="cal-add-btn" data-cal-date="' + date + '" data-cal-slot="' + slot + '">+ Add</button>'
      html += '</div>'
    })

    html += '</div>'
  })

  // Recipe picker modal for calendar
  if (state.calendarSlot) {
    const { date, slot } = state.calendarSlot
    const search = state.calendarSearch || ''
    const tagFilter = state.calendarTagFilter
    const recipeTags = getTagsForNamespace('recipe')

    let results = state.recipes
    if (tagFilter) results = results.filter(r => (r.tags||[]).includes(tagFilter))
    if (search) results = results.filter(r => r.name.toLowerCase().includes(search.toLowerCase()))
    results = results.slice(0, 12)

    html += '<div class="modal-bg" id="cal-picker-bg">'
    html += '<div class="modal-sheet">'
    html += '<div class="modal-title">Add to ' + slot + '</div>'
    html += '<div class="modal-sub">' + formatDate(date) + '</div>'
    html += '<input id="cal-search-input" class="cal-search" placeholder="Search recipes..." value="' + esc(search) + '" />'

    // Tag filter chips
    if (recipeTags.length > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">'
      html += '<button class="tag-filter-chip ' + (!tagFilter ? 'active' : '') + '" data-cal-tag="">All</button>'
      recipeTags.forEach(t => {
        html += '<button class="tag-filter-chip ' + (tagFilter === t.name ? 'active' : '') + '" data-cal-tag="' + esc(t.name) + '">' + esc(t.name) + '</button>'
      })
      html += '</div>'
    }

    html += '<div class="cal-recipe-list">'
    if (results.length === 0) {
      html += '<div class="empty-state" style="padding:20px">No recipes found</div>'
    } else {
      results.forEach(r => {
        const tagChips = (r.tags||[]).map(t => '<span class="tag-chip-small">' + esc(t) + '</span>').join('')
        html += '<button class="cal-recipe-option" data-pick-recipe="' + r.id + '" data-pick-name="' + esc(r.name) + '">' +
          esc(r.name) + (tagChips ? '<div>' + tagChips + '</div>' : '') +
        '</button>'
      })
    }
    html += '</div>'
    html += '<div class="modal-btns"><button class="modal-cancel" id="cal-picker-cancel">Cancel</button></div>'
    html += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--cream3)">'
    html += '<div style="font-size:11px;color:var(--ink3);margin-bottom:6px">Or type anything (e.g. Chips, Protein bar):</div>'
    html += '<div style="display:flex;gap:7px">'
    html += '<input id="cal-manual-input" placeholder="e.g. Chips" style="flex:1;padding:9px 12px;border:1.5px solid var(--border);border-radius:12px;font-size:13px;font-family:inherit" />'
    html += '<button class="add-btn" id="cal-manual-add">Add</button>'
    html += '</div></div>'
    html += '</div></div>'
  }

  html += '</div>'
  return html
}


function renderHistory() {
  const fullLog = state.historyLog
  if (!fullLog.length) {
    return '<div class="tab-content"><div class="section-title">History</div><div class="empty-state">No history yet. Start logging meals and it will show up here!</div></div>'
  }

  // Group by date
  const byDate = {}
  fullLog.forEach(e => {
    const date = e.logged_at?.slice(0,10)
    if (!date) return
    if (!byDate[date]) byDate[date] = []
    byDate[date].push(e)
  })

  // Get week dates for current history offset
  const weekDates = getWeekDates(state.historyOffset)
  const weekLabel = state.historyOffset === 0 ? 'This Week' : state.historyOffset === -1 ? 'Last Week' : formatDate(weekDates[0]) + ' - ' + formatDate(weekDates[6])

  // Build profile
  const profile = buildAgentProfile(fullLog, [])
  const avgCals = profile?.avgCals || 0
  const daysOnTarget = profile?.daysOnTarget || 0
  const totalDays = profile?.totalDays || 0

  let html = '<div class="tab-content">'

  // Summary card
  if (profile) {
    html += '<div class="history-summary">'
    html += '<div class="history-summary-title">Last ' + totalDays + ' days</div>'
    html += '<div class="history-stats">'
    html += '<div class="history-stat"><div class="history-stat-val">' + avgCals + '</div><div class="history-stat-label">Avg cal/day</div></div>'
    html += '<div class="history-stat"><div class="history-stat-val">' + daysOnTarget + '</div><div class="history-stat-label">On target</div></div>'
    html += '<div class="history-stat"><div class="history-stat-val">' + (profile.daysOver||0) + '</div><div class="history-stat-label">Over goal</div></div>'
    html += '<div class="history-stat"><div class="history-stat-val">' + (profile.daysUnder||0) + '</div><div class="history-stat-label">Under goal</div></div>'
    html += '</div>'
    if (profile.topRecipes.length) {
      html += '<div class="history-insight">Most cooked: ' + profile.topRecipes.slice(0,3).join(', ') + '</div>'
    }
    if (profile.staleRecipes.length) {
      html += '<div class="history-insight">Not cooked recently: ' + profile.staleRecipes.slice(0,3).join(', ') + '</div>'
    }
    if (profile.weakDays.length) {
      html += '<div class="history-insight">Low calorie days: ' + profile.weakDays.join(', ') + '</div>'
    }
    html += '</div>'
  }

  // Week navigation
  html += '<div class="cal-header" style="margin-bottom:10px">'
  html += '<button class="cal-nav" data-history-nav="-1">&lsaquo;</button>'
  html += '<div class="cal-week-label">' + weekLabel + '</div>'
  html += '<button class="cal-nav" data-history-nav="1">&rsaquo;</button>'
  html += '</div>'

  // Day entries for selected week
  const weekDays = weekDates.filter(d => byDate[d])
  if (!weekDays.length) {
    html += '<div class="empty-state" style="padding:20px">No entries this week</div>'
  } else {
    weekDates.forEach(date => {
      const entries = byDate[date]
      if (!entries) return
      const dayTotal = entries.reduce((s,e) => s + (e.calories||0), 0)
      const onTarget = Math.abs(dayTotal - state.goals.calories) < 200
      const over = dayTotal > state.goals.calories + 200
      html += '<div class="history-day">'
      html += '<div class="history-day-header">'
      html += '<span class="history-day-name">' + formatDate(date) + '</span>'
      html += '<span class="history-day-total ' + (over ? 'over' : onTarget ? 'on-target' : '') + '">' + dayTotal + ' cal</span>'
      html += '</div>'
      entries.forEach(e => {
        html += '<div class="history-entry">'
        html += '<span class="history-entry-food">' + esc(e.food) + '</span>'
        html += '<span class="history-entry-cal">' + (e.calories||0) + ' cal</span>'
        html += '</div>'
      })
      html += '</div>'
    })
  }

  html += '</div>'
  return html
}

function renderTags() {
  const namespaces = [
    { key: 'recipe', label: 'Recipe Tags', hint: 'For recipes - meal type, occasion, cooking method, main ingredient' },
    { key: 'location', label: 'Pantry/Store Tags', hint: 'For pantry items and shopping list - store aisle or home storage location' },
  ]
  return '<div class="tab-content">' +
    '<div class="section-title">Tag Library</div>' +
    namespaces.map(ns => {
      const tags = getTagsForNamespace(ns.key)
      return '<div class="tags-section">' +
        '<div class="tags-section-title">' + ns.label + '</div>' +
        '<div class="tags-section-hint">' + ns.hint + '</div>' +
        '<div class="tags-section-chips">' +
          tags.map(t =>
            '<span class="tag-library-chip">' + esc(t.name) +
            '<button class="tag-lib-del" data-del-tag-id="' + t.id + '" data-del-tag-ns="' + ns.key + '">×</button>' +
            '</span>'
          ).join('') +
        '</div>' +
        '<div class="tag-add-row">' +
          '<input class="tag-lib-input" id="new-lib-tag-' + ns.key + '" placeholder="New ' + ns.label.toLowerCase() + '..." />' +
          '<button class="add-btn" data-add-lib-tag="' + ns.key + '">+ Add</button>' +
        '</div>' +
      '</div>'
    }).join('') +
  '</div>'
}

function renderChat() {
  const messages = state.chatMessages

  const chatHtml = messages.length === 0
    ? '<div class="chat-empty"><div class="chat-empty-title">Your AI Food Coach</div><div class="chat-empty-sub">Ask about meal planning, recipes, calories, shopping — anything food related. I know your recipes, pantry and eating patterns.</div><div class="chat-empty-prompts">' +
      ['Plan my week', 'What should I eat today?', 'What can I make with my pantry?', 'How am I doing with my goals?'].map(p =>
        '<button class="chat-starter" data-prompt-text="' + esc(p) + '">' + esc(p) + '</button>'
      ).join('') +
      '</div></div>'
    : messages.map(m =>
        '<div class="chat-msg chat-msg-' + m.role + '">' +
          '<div class="chat-bubble">' + esc(m.content) + '</div>' +
        '</div>'
      ).join('')

  return '<div class="chat-fullpage">' +
    '<div class="chat-messages" id="chat-messages">' + chatHtml + '</div>' +
    (state.chatLoading ? '<div class="chat-loading"><div class="chat-dots"><span></span><span></span><span></span></div></div>' : '') +
    (messages.length > 0 ? '<button class="chat-clear-btn" id="chat-clear">Clear conversation</button>' : '') +
    '<div class="chat-input-row">' +
      '<input id="chat-input" class="chat-input" placeholder="Message your food coach..." />' +
      '<button class="chat-send-btn" id="chat-send" ' + (state.chatLoading ? 'disabled' : '') + '>&#9654;</button>' +
    '</div>' +
  '</div>'
}


function renderAddToWeekModal() {
  const m = state.addToWeekModal
  const slots = ['Breakfast', 'Lunch', 'Dinner', 'Snack']
  // Generate next 7 days
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i)
    const iso = d.toISOString().slice(0, 10)
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    days.push({ iso, label })
  }
  const selectedDay = m.selectedDay || days[0].iso
  return '<div class="modal-bg" id="add-week-bg">' +
    '<div class="modal-sheet">' +
      '<div class="modal-title">+ Week</div>' +
      '<div class="modal-sub">' + esc(m.recipeName) + '</div>' +
      '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Day</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">' +
        days.map(d =>
          '<button class="tag-filter-chip ' + (selectedDay === d.iso ? 'active' : '') + '" data-week-day="' + d.iso + '">' + d.label + '</button>'
        ).join('') +
      '</div>' +
      '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Meal</div>' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px">' +
        slots.map(s =>
          '<button class="tag-filter-chip ' + (m.selectedSlot === s ? 'active' : '') + '" data-week-slot="' + s + '">' + s + '</button>'
        ).join('') +
      '</div>' +
      '<div class="modal-btns">' +
        '<button class="modal-cancel" id="add-week-cancel">Cancel</button>' +
        '<button class="modal-save" id="add-week-save" ' + (!m.selectedSlot ? 'disabled style="opacity:0.5"' : '') + '>Add to ' + (m.selectedSlot || 'Week') + '</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

function renderClipUrlModal() {
  return '<div class="modal-bg" id="clip-url-modal-bg">' +
    '<div class="modal-sheet">' +
      '<div class="modal-title">Clip from URL</div>' +
      '<div class="modal-sub">Paste a recipe link and we will fetch it automatically</div>' +
      '<input id="clip-url-input" placeholder="https://..." style="font-family:monospace;font-size:13px" />' +
      '<div class="modal-btns">' +
        '<button class="modal-cancel" id="clip-url-cancel">Cancel</button>' +
        '<button class="modal-save" id="clip-url-go">Fetch Recipe</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}


function renderPasteModal() {
  if (state.shareLoading) {
    return '<div class="modal-bg" id="paste-modal-bg"><div class="modal-sheet" style="text-align:center;padding:40px 20px">' +
      '<div style="font-size:32px;margin-bottom:12px">&#x1F372;</div>' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:8px">Reading recipe...</div>' +
      '<div style="color:var(--muted);font-size:13px">Fetching from the page you shared</div>' +
      '</div></div>'
  }
  const r = state.sharedRecipe
  const title = r ? 'Save Clipped Recipe' : 'Paste a Recipe'
  const sub = r ? esc(r.source || '') : 'From YouTube, Instagram, a comment, anywhere'
  const warning = r && r.warning ? '<div class="modal-note" style="color:var(--terra);background:#fff5f2;border-radius:8px;padding:8px 10px;margin-bottom:8px">[!] ' + esc(r.warning) + '</div>' : ''
  const nameVal = r ? esc(r.name || '') : ''
  const bodyFields = r ?
    '<div class="clip-field-label">Ingredients</div><textarea id="paste-ingredients" style="min-height:100px" placeholder="One ingredient per line...">' + esc(r.ingredients || '') + '</textarea>' +
    '<div class="clip-field-label">Instructions</div><textarea id="paste-instructions" style="min-height:80px" placeholder="Step by step...">' + esc(r.instructions || '') + '</textarea>'
  :
    '<textarea id="paste-text" style="min-height:160px" placeholder="Paste the recipe text - ingredients, instructions, however messy. Edit before saving."></textarea>'
  return '<div class="modal-bg" id="paste-modal-bg"><div class="modal-sheet">' +
    '<div class="modal-title">' + title + '</div>' +
    '<div class="modal-sub">' + sub + '</div>' +
    warning +
    '<input id="paste-name" placeholder="Recipe name" value="' + nameVal + '" />' +
    bodyFields +
    '<div class="modal-btns"><button class="modal-cancel" id="paste-cancel">Cancel</button><button class="modal-save" id="paste-save">Save to Recipe Box</button></div>' +
    '</div></div>'
}

function renderShopReview() {
  const s = state.shopReview
  const itemsHtml = s.items.map(function(item, idx) {
    const pantryInfo = item.pantryQty
      ? '<div class="shop-review-have">You have: ' + esc(item.pantryQty) + '</div>'
      : '<div class="shop-review-none">Not in pantry</div>'
    return '<label class="shop-review-row">' +
      '<input type="checkbox" class="shop-review-check" data-idx="' + idx + '" ' + (item.checked ? 'checked' : '') + ' />' +
      '<div class="shop-review-info">' +
        '<div class="shop-review-name">' + esc(item.name) + '</div>' +
        pantryInfo +
      '</div>' +
    '</label>'
  }).join('')
  return '<div class="modal-bg" id="shop-review-bg"><div class="modal-sheet">' +
    '<div class="modal-title">What do you need?</div>' +
    '<div class="modal-sub">' + esc(s.recipeName) + '</div>' +
    '<div class="shop-review-hint">Pre-checked items are not in your pantry. Adjust as needed.</div>' +
    '<div class="shop-review-list">' + itemsHtml + '</div>' +
    '<div class="modal-btns"><button class="modal-cancel" id="shop-review-cancel">Cancel</button><button class="modal-save" id="shop-review-add">Add to Shopping List</button></div>' +
    '</div></div>'
}

function renderLogModal() {
  const m = state.logModal
  const recipe = m.recipeId ? state.recipes.find(r => String(r.id) === String(m.recipeId)) : null
  const estimating = m.estimating || false
  return '<div class="modal-bg" id="log-modal-bg">' +
    '<div class="modal-sheet">' +
      '<div class="modal-title">Log a serving</div>' +
      '<div class="modal-sub">' + esc(m.recipeName) + '</div>' +
      '<input id="lm-portion" placeholder="How much? (e.g. 1 cup, 2 servings)" />' +
      '<div class="lm-cal-row">' +
        '<input id="lm-cals" type="number" placeholder="Calories" style="flex:1" />' +
        (recipe ? '<button class="lm-estimate-btn" id="lm-estimate">Ask Claude</button>' : '') +
      '</div>' +
      (m.estimateMsg ? '<div class="modal-note">' + esc(m.estimateMsg) + '</div>' : '<div class="modal-note">Enter portion, tap Ask Claude for a calorie estimate, then come back and type the number.</div>') +
      '<div class="modal-btns">' +
        '<button class="modal-cancel" id="lm-cancel">Cancel</button>' +
        '<button class="modal-save" id="lm-save">Add to Log</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(el => {
    el.addEventListener('click', () => { state.tab = el.dataset.tab; render() })
  })

  // Goals
  document.getElementById('goals-toggle')?.addEventListener('click', () => { state.showGoals = !state.showGoals; state.showSync = false; render() })

  // ── TAG EVENTS ──

  // Filter toggle button (open/close the dropdown)
  document.querySelectorAll('.tag-filter-toggle[data-filter-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      const ns = el.dataset.filterToggle
      if (state.showTagFilter && state.activeTagFilterNs === ns) {
        state.showTagFilter = false
      } else {
        state.showTagFilter = true
        state.activeTagFilterNs = ns
      }
      render()
    })
  })

  // Filter chips
  document.querySelectorAll('.tag-filter-chip[data-filter-tag]').forEach(el => {
    el.addEventListener('click', () => {
      state.activeTagFilter = el.dataset.filterTag || null
      state.activeTagFilterNs = el.dataset.filterNs || null
      state.showTagFilter = false
      render()
    })
  })

  // Tag input - show/hide suggestions on focus
  document.querySelectorAll('.tag-input[data-tag-item]').forEach(el => {
    el.addEventListener('focus', () => {
      const sugg = document.getElementById('tag-sugg-' + el.dataset.tagItem)
      if (sugg) sugg.style.display = 'flex'
    })
    el.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const name = el.value.trim()
        if (!name) return
        const ns = el.dataset.tagNs
        const itemId = el.dataset.tagItem
        await addTagToItem(name, ns, itemId)
      }
    })
    el.addEventListener('input', () => {
      const val = el.value.toLowerCase()
      const sugg = document.getElementById('tag-sugg-' + el.dataset.tagItem)
      if (!sugg) return
      sugg.querySelectorAll('.tag-suggestion').forEach(btn => {
        btn.style.display = btn.dataset.suggTag.toLowerCase().includes(val) ? 'block' : 'none'
      })
      sugg.style.display = 'flex'
    })
  })

  // Click suggestion
  document.querySelectorAll('.tag-suggestion[data-sugg-tag]').forEach(el => {
    el.addEventListener('click', async e => {
      e.preventDefault()
      await addTagToItem(el.dataset.suggTag, el.dataset.tagNs, el.dataset.tagItem)
    })
  })

  // Remove tag
  document.querySelectorAll('.tag-chip-remove[data-remove-tag]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      await removeTagFromItem(el.dataset.removeTag, el.dataset.tagNs, el.dataset.tagItem)
    })
  })
  document.getElementById('sync-toggle')?.addEventListener('click', () => { state.showSync = !state.showSync; state.showGoals = false; render() })
  document.getElementById('sync-copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(getUserId()).then(() => {
      document.getElementById('sync-id-display').textContent = "Copied!";
      setTimeout(() => render(), 1500);
    });
  })
  document.getElementById('sync-bookmark-btn')?.addEventListener('click', () => {
    const bookmarkUrl = window.location.origin + '/?uid=' + getUserId()
    navigator.clipboard.writeText(bookmarkUrl).then(() => {
      const btn = document.getElementById('sync-bookmark-btn')
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => render(), 1500) }
    })
  })
  document.getElementById('sync-switch-btn')?.addEventListener('click', async () => {
    const newId = document.getElementById('sync-input')?.value?.trim();
    if (!newId || !newId.startsWith('user_')) { alert('Please enter a valid Account ID (starts with user_)'); return; }
    if (!confirm("Switch to this account? Your current local data will be replaced with that accounts data.")) return;
    localStorage.setItem('nourish_uid', newId);
    state.showSync = false;
    state.loading = true;
    render();
    const [recipes, pantry, shopList, log, goals] = await Promise.all([
      db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals()
    ]);
    state.recipes  = recipes.map(r => ({ ...r, cookingNotes: r.cooking_notes||'', clippedFrom: r.clipped_from||'', text: [r.ingredients,r.instructions].filter(Boolean).join('\n\n') }));
    state.pantry   = pantry;
    state.shopList = shopList.map(i => ({ ...i, fromRecipe: i.from_recipe }));
    state.log      = log;
    if (goals) state.goals = { calories: goals.calories, goal: goals.goal_type };
    state.loading  = false;
    render();
  })
  document.querySelectorAll('.preset-btn[data-preset]').forEach(el => {
    el.addEventListener('click', async () => {
      const p = GOAL_PRESETS[el.dataset.preset]
      state.goals = { calories: p.calories, goal: el.dataset.preset }
      render(); await db.saveGoals(state.goals)
    })
  })
  document.querySelectorAll('input[data-goal]').forEach(el => {
    el.addEventListener('change', async () => {
      state.goals[el.dataset.goal] = parseInt(el.value) || 0
      await db.saveGoals(state.goals)
    })
  })

  // Recipes
  // Category filter chips
  document.querySelectorAll('.category-chip[data-category]').forEach(el => {
    el.addEventListener('click', () => { state.activeCategory = el.dataset.category; state.expandedRecipe = null; render() })
  })

  // Inline category change
  document.querySelectorAll('[data-cat-recipe]').forEach(el => {
    el.addEventListener('change', async e => {
      e.stopPropagation()
      const r = state.recipes.find(x => String(x.id) === String(el.dataset.catRecipe))
      if (r) { r.category = el.value; await db.updateRecipe(r.id, { category: el.value }); render() }
    })
  })

  document.getElementById('add-recipe-btn')?.addEventListener('click', () => { state.addRecipeModal = !state.addRecipeModal; render(); setTimeout(() => document.getElementById('r-name')?.focus(), 50) })
  document.getElementById('r-cancel-btn')?.addEventListener('click', () => { state.addRecipeModal = false; render() })
  document.getElementById('r-save-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('r-name')?.value?.trim()
    const ingredients = document.getElementById('r-ingredients')?.value?.trim()
    const instructions = document.getElementById('r-instructions')?.value?.trim()
    const notes = document.getElementById('r-notes')?.value?.trim()
    const category = document.getElementById('r-category')?.value || ''
    if (!name) return
    const saved = await db.saveRecipe({ name, ingredients, instructions, notes, category })
    if (saved) state.recipes.unshift(normalizeRecipe(saved))
    state.addRecipeModal = false; render()
  })

  document.querySelectorAll('.recipe-card-header').forEach(el => {
    el.addEventListener('click', () => {
      const rid = el.closest('.recipe-card').dataset.rid
      state.expandedRecipe = state.expandedRecipe === rid ? null : rid
      render()
    })
  })

  // Recipe ingredients/instructions editing
  document.querySelectorAll('[data-recipe-edit]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const rid = el.dataset.recipeEdit
      state.editingRecipeId = state.editingRecipeId === rid ? null : rid
      render()
      setTimeout(() => document.getElementById('edit-ingredients-' + rid)?.focus(), 50)
    })
  })
  document.querySelectorAll('[data-recipe-save]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const rid = el.dataset.recipeSave
      const recipe = state.recipes.find(r => String(r.id) === String(rid))
      const ingredients = document.getElementById('edit-ingredients-' + rid)?.value?.trim()
      const instructions = document.getElementById('edit-instructions-' + rid)?.value?.trim()
      if (recipe) {
        recipe.ingredients = ingredients
        recipe.instructions = instructions
        await db.updateRecipe(rid, { ingredients, instructions })
      }
      state.editingRecipeId = null
      render()
    })
  })

  document.querySelectorAll('[data-notes-edit]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const rid = el.dataset.notesEdit
      state.editingNotes = state.editingNotes === rid ? null : rid
      render(); setTimeout(() => document.getElementById('notes-ta-' + rid)?.focus(), 50)
    })
  })

  document.querySelectorAll('[data-notes-save]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const rid = el.dataset.notesSave
      const val = document.getElementById('notes-ta-' + rid)?.value?.trim()
      const recipe = state.recipes.find(r => r.id === rid)
      if (recipe) { recipe.cookingNotes = val; await db.updateRecipe(rid, { cookingNotes: val }) }
      state.editingNotes = null; render()
    })
  })

  document.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.del
      state.recipes = state.recipes.filter(r => r.id !== id)
      state.expandedRecipe = null
      await db.deleteRecipe(id); render()
    })
  })

  document.querySelectorAll('[data-ask]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const r = state.recipes.find(x => x.id === el.dataset.ask)
      if (r) { state.tab = 'chat'; sendChatMessage('Tell me ways I can use this recipe this week: ' + r.name + '. Ingredients: ' + (r.ingredients||'')); render() }
    })
  })

  // Pantry
  document.getElementById('pantry-add-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('pantry-name')?.value?.trim()
    const qty  = document.getElementById('pantry-qty')?.value?.trim()
    if (!name) return
    const tags = Array.from(document.querySelectorAll('.pantry-new-tag-check:checked')).map(el => el.dataset.tag)
    const saved = await db.addPantryItem(name, qty)
    if (saved) {
      if (tags.length) { saved.tags = tags; await db.updatePantryTags(saved.id, tags) }
      state.pantry.push(saved)
    }
    document.getElementById('pantry-name').value = ''
    if (document.getElementById('pantry-qty')) document.getElementById('pantry-qty').value = ''
    document.querySelectorAll('.pantry-new-tag-check').forEach(el => el.checked = false)
    render()
  })
  ;['pantry-name','pantry-qty'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pantry-add-btn')?.click() })
  })
  document.querySelectorAll('[data-qty-id]').forEach(el => {
    el.addEventListener('change', async () => {
      const item = state.pantry.find(p => p.id === el.dataset.qtyId)
      if (item) { item.qty = el.value.trim(); await db.updatePantryItem(item.id, item.qty) }
    })
  })
  document.querySelectorAll('[data-pantry-del]').forEach(el => {
    el.addEventListener('click', async () => {
      state.pantry = state.pantry.filter(p => p.id !== el.dataset.pantryDel)
      await db.deletePantryItem(el.dataset.pantryDel); render()
    })
  })
  document.getElementById('clear-pantry')?.addEventListener('click', async () => {
    if (confirm('Clear entire pantry?')) { state.pantry = []; await db.clearPantry(); render() }
  })

  // Shopping list
  document.querySelectorAll('[data-shop]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const r = state.recipes.find(x => x.id === el.dataset.shop)
      if (!r) return
      const ingLines = (r.ingredients || r.text || '').split('\n')
        .map(l => l.replace(/^[•\-\d\.]+\s*/, '').trim()).filter(l => l.length > 2 && l.length < 120)
      const items = ingLines.map(raw => {
        const name = parseIngredientLine(raw)
        const stripped = stripMeasurements(raw)
        const match = state.pantry.find(p => {
          const pl = p.name.toLowerCase()
          return stripped.includes(pl) || pl.includes(stripped.split(' ').filter(w => w.length > 2)[0] || stripped)
        })
        return { name, pantryQty: match ? (match.qty || '✓ in pantry') : null, checked: !match }
      })
      state.shopReview = { recipeId: r.id, recipeName: r.name, items }; render()
    })
  })

  document.querySelectorAll('.shop-review-check').forEach(el => {
    el.addEventListener('change', () => { if (state.shopReview) state.shopReview.items[+el.dataset.idx].checked = el.checked })
  })
  document.getElementById('shop-review-cancel')?.addEventListener('click', () => { state.shopReview = null; render() })
  document.getElementById('shop-review-bg')?.addEventListener('click', e => { if (e.target.id === 'shop-review-bg') { state.shopReview = null; render() } })
  document.getElementById('shop-review-add')?.addEventListener('click', async () => {
    if (!state.shopReview) return
    const toAdd = state.shopReview.items.filter(i => i.checked)
    for (const item of toAdd) {
      const already = state.shopList.some(s => s.name.toLowerCase() === item.name.toLowerCase())
      if (!already) {
        const saved = await db.addShopItem(item.name, state.shopReview.recipeName)
        if (saved) state.shopList.push({ ...saved, fromRecipe: saved.from_recipe })
      }
    }
    state.shopReview = null; state.tab = 'shop'; render()
  })

  document.querySelectorAll('[data-check]').forEach(el => {
    el.addEventListener('click', async () => {
      const item = state.shopList.find(x => x.id === el.dataset.check)
      if (item) { item.have = true; await db.updateShopItem(item.id, true); render() }
    })
  })
  document.querySelectorAll('[data-uncheck]').forEach(el => {
    el.addEventListener('click', async () => {
      const item = state.shopList.find(x => x.id === el.dataset.uncheck)
      if (item) { item.have = false; await db.updateShopItem(item.id, false); render() }
    })
  })
  document.querySelectorAll('[data-shop-del]').forEach(el => {
    el.addEventListener('click', async () => {
      state.shopList = state.shopList.filter(x => x.id !== el.dataset.shopDel)
      await db.deleteShopItem(el.dataset.shopDel); render()
    })
  })
  document.getElementById('shop-got-it')?.addEventListener('click', async () => {
    await db.markAllGotIt(state.shopList, state.pantry)
    const newPantry = await db.fetchPantry()
    state.pantry = newPantry
    state.shopList = state.shopList.map(i => ({ ...i, have: true })); render()
  })
  document.getElementById('shop-clear')?.addEventListener('click', async () => {
    if (confirm('Clear shopping list?')) { state.shopList = []; await db.clearShopList(); render() }
  })
  document.getElementById('shop-copy-btn')?.addEventListener('click', () => {
    const need = state.shopList.filter(i => !i.have)
    const text = need.map(i => '• ' + i.name).join('\n')
    navigator.clipboard.writeText(text).then(() => alert('Shopping list copied!'))
  })
  document.getElementById('shop-manual-add')?.addEventListener('click', async () => {
    const val = document.getElementById('shop-manual-input')?.value?.trim()
    if (!val) return
    const tags = Array.from(document.querySelectorAll('.shop-new-tag-check:checked')).map(el => el.dataset.tag)
    const saved = await db.addShopItem(val, 'Manual')
    if (saved) {
      if (tags.length) { saved.tags = tags; await db.updateShopItemTags(saved.id, tags) }
      state.shopList.push({ ...saved, fromRecipe: 'Manual', tags })
    }
    document.getElementById('shop-manual-input').value = ''
    document.querySelectorAll('.shop-new-tag-check').forEach(el => el.checked = false)
    render()
  })
  document.getElementById('shop-manual-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('shop-manual-add')?.click() })

  // Log
  document.getElementById('log-add-btn')?.addEventListener('click', async () => {
    const food = document.getElementById('log-food')?.value?.trim()
    const cals = parseInt(document.getElementById('log-cals')?.value)
    if (!food) return
    const saved = await db.addLogEntry(food, cals||0)
    if (saved) state.log.push(saved); render()
  })
  document.getElementById('log-food')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('log-add-btn')?.click() })
  document.querySelectorAll('[data-log-del]').forEach(el => {
    el.addEventListener('click', async () => {
      state.log = state.log.filter(x => x.id !== el.dataset.logDel)
      await db.deleteLogEntry(el.dataset.logDel); render()
    })
  })
  document.querySelectorAll('.ra-log[data-log-recipe]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const r = state.recipes.find(x => String(x.id) === String(el.dataset.logRecipe))
      if (r) { state.logModal = { recipeId: r.id, recipeName: r.name }; render() }
    })
  })
  document.getElementById('lm-cancel')?.addEventListener('click', () => { state.logModal = null; render() })

  // Ask Claude for calorie estimate (in-app chat)
  document.getElementById('lm-estimate')?.addEventListener('click', () => {
    const portion = document.getElementById('lm-portion')?.value?.trim()
    const recipe = state.logModal.recipeId ? state.recipes.find(r => String(r.id) === String(state.logModal.recipeId)) : null
    if (!recipe) return
    const q = portion
      ? "How many calories in " + portion + " of this recipe? Just give me a single number.\n\nRecipe: " + recipe.name + "\nIngredients: " + (recipe.ingredients || "")
      : "How many calories per serving of this recipe?\n\nRecipe: " + recipe.name + "\nIngredients: " + (recipe.ingredients || "")
    state.logModal = null
    state.tab = 'chat'
    sendChatMessage(q)
    render()
  })
  document.getElementById('log-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'log-modal-bg') { state.logModal = null; render() } })
  document.getElementById('lm-save')?.addEventListener('click', async () => {
    const portionEl = document.getElementById('lm-portion')
    const calsEl = document.getElementById('lm-cals')
    const portion = portionEl?.value?.trim()
    const cals = parseInt(calsEl?.value) || 0
    if (!portion) {
      if (portionEl) portionEl.placeholder = 'Please enter portion!'
      portionEl?.focus()
      return
    }
    const food = (state.logModal?.recipeName || 'Food') + ' (' + portion + ')'
    const saved = await db.addLogEntry(food, cals)
    if (saved) {
      if (state.logModal?.recipeId) saved.recipe_id = state.logModal.recipeId
      state.log.push(saved)
    }
    state.logModal = null; state.tab = 'log'; render()
  })

  // Paste modal
  document.getElementById('paste-btn')?.addEventListener('click', () => { state.pasteModal = true; render(); setTimeout(() => document.getElementById('paste-name')?.focus(), 50) })

  // Clip URL modal
  document.getElementById('clip-url-btn')?.addEventListener('click', async () => {
    state.clipUrlModal = true; render()
    setTimeout(async () => {
      try {
        const text = await navigator.clipboard.readText()
        const input = document.getElementById('clip-url-input')
        if (input && text && text.startsWith('http')) input.value = text
      } catch(e) {}
      document.getElementById('clip-url-input')?.focus()
    }, 100)
  })
  document.getElementById('clip-url-cancel')?.addEventListener('click', () => { state.clipUrlModal = false; render() })
  document.getElementById('clip-url-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'clip-url-modal-bg') { state.clipUrlModal = false; render() } })
  document.getElementById('clip-url-go')?.addEventListener('click', async () => {
    const url = document.getElementById('clip-url-input')?.value?.trim()
    if (!url || !url.startsWith('http')) return
    state.clipUrlModal = false; state.pasteModal = true; state.shareLoading = true; render()
    try {
      const resp = await fetch('/api/scrape?url=' + encodeURIComponent(url))
      const recipe = await resp.json()
      if (recipe.error) throw new Error(recipe.error)
      state.shareLoading = false; state.sharedRecipe = recipe; render()
    } catch(e) {
      state.shareLoading = false; state.sharedRecipe = null; render()
    }
  })
  document.getElementById('clip-url-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('clip-url-go')?.click() })

  // Clipboard banner
  document.getElementById('clipboard-yes')?.addEventListener('click', async () => {
    const url = state.clipboardBanner
    state.clipboardBanner = null; state.pasteModal = true; state.shareLoading = true; render()
    try {
      const resp = await fetch('/api/scrape?url=' + encodeURIComponent(url))
      const recipe = await resp.json()
      if (recipe.error) throw new Error(recipe.error)
      state.shareLoading = false; state.sharedRecipe = recipe; render()
    } catch(e) { state.shareLoading = false; state.sharedRecipe = null; render() }
  })
  document.getElementById('clipboard-no')?.addEventListener('click', () => { state.clipboardBanner = null; render() })

  // Pantry inline edit
  document.querySelectorAll('[data-edit-pantry]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.editingPantryId = String(el.dataset.editPantry); render()
      setTimeout(() => document.querySelector('[data-edit-pantry-name]')?.focus(), 50)
    })
  })
  document.querySelectorAll('[data-save-pantry]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.savePantry
      const name = document.querySelector('[data-edit-pantry-name="' + id + '"]')?.value?.trim()
      const qty = document.querySelector('[data-qty-id="' + id + '"]')?.value?.trim()
      if (!name) return
      const item = state.pantry.find(p => String(p.id) === String(id))
      if (item) { item.name = name; item.qty = qty; await db.updatePantryItem(id, { name, qty }) }
      state.editingPantryId = null; render()
    })
  })
  document.querySelectorAll('[data-edit-pantry-name]').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') document.querySelector('[data-save-pantry="' + el.dataset.editPantryName + '"]')?.click() })
  })
  // Move pantry -> list
  document.querySelectorAll('[data-move-to-list]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.moveToList
      const item = state.pantry.find(p => String(p.id) === String(id))
      if (!item) return
      const saved = await db.addShopItem(item.name, 'Pantry')
      if (saved) state.shopList.push({ ...saved, fromRecipe: 'Pantry' })
      await db.deletePantryItem(id)
      state.pantry = state.pantry.filter(p => String(p.id) !== String(id))
      render()
    })
  })

  // Shop list inline edit
  document.querySelectorAll('[data-edit-shop]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.editingShopId = String(el.dataset.editShop); render()
      setTimeout(() => document.querySelector('[data-edit-shop-name]')?.focus(), 50)
    })
  })
  document.querySelectorAll('[data-save-shop]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.saveShop
      const name = document.querySelector('[data-edit-shop-name="' + id + '"]')?.value?.trim()
      if (!name) return
      const item = state.shopList.find(i => String(i.id) === String(id))
      if (item) { item.name = name; await db.updateShopItem(id, { name }) }
      state.editingShopId = null; render()
    })
  })
  document.querySelectorAll('[data-edit-shop-name]').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') document.querySelector('[data-save-shop="' + el.dataset.editShopName + '"]')?.click() })
  })
  // Move list -> pantry
  document.querySelectorAll('[data-move-to-pantry]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.moveToPantry
      const item = state.shopList.find(i => String(i.id) === String(id))
      if (!item) return
      const saved = await db.addPantryItem(item.name, '')
      if (saved) state.pantry.push(saved)
      await db.deleteShopItem(id)
      state.shopList = state.shopList.filter(i => String(i.id) !== String(id))
      render()
    })
  })
  document.getElementById('paste-cancel')?.addEventListener('click', () => { state.pasteModal = false; state.sharedRecipe = null; state.shareLoading = false; render() })
  document.getElementById('paste-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'paste-modal-bg') { state.pasteModal = false; state.sharedRecipe = null; state.shareLoading = false; render() } })
  document.getElementById('paste-save')?.addEventListener('click', async () => {
    const name = document.getElementById('paste-name')?.value?.trim()
    if (!name) return
    let ingredients = '', instructions = ''
    if (state.sharedRecipe) {
      ingredients = document.getElementById('paste-ingredients')?.value?.trim() || ''
      instructions = document.getElementById('paste-instructions')?.value?.trim() || ''
    } else {
      const text = document.getElementById('paste-text')?.value?.trim() || ''
      if (!text) return
      ingredients = text; instructions = ''
      const splitMatch = text.match(/^([\s\S]*?)(?:instructions?|directions?|steps?|method|how to make)[:\s]*([\s\S]*)$/i)
      if (splitMatch) { ingredients = splitMatch[1].replace(/ingredients?[:\s]*/i,'').trim(); instructions = splitMatch[2].trim() }
    }
    const clippedFrom = state.sharedRecipe?.url || ''
    const saved = await db.saveRecipe({ name, ingredients, instructions, notes: '', clippedFrom })
    if (saved) state.recipes.unshift(normalizeRecipe(saved))
    state.pasteModal = false; state.sharedRecipe = null; state.shareLoading = false; state.tab = 'recipes'; render()
  })

  // Chat handled by chat handlers below



  // ── TAG LIBRARY HANDLERS ──

  // Add tag from library tab
  document.querySelectorAll('[data-add-lib-tag]').forEach(el => {
    el.addEventListener('click', async () => {
      const ns = el.dataset.addLibTag
      const input = document.getElementById('new-lib-tag-' + ns)
      const name = input?.value?.trim()
      if (!name) return
      const saved = await db.saveTag(name, ns)
      if (saved && !state.allTags.find(t => t.name === name && t.namespace === ns)) state.allTags.push(saved)
      if (input) input.value = ''
      render()
    })
  })
  document.querySelectorAll('.tag-lib-input').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const ns = el.id.replace('new-lib-tag-', '')
        document.querySelector('[data-add-lib-tag="' + ns + '"]')?.click()
      }
    })
  })
  document.querySelectorAll('.tag-lib-del[data-del-tag-id]').forEach(el => {
    el.addEventListener('click', async () => {
      await db.deleteTag(el.dataset.delTagId)
      state.allTags = state.allTags.filter(t => t.id !== el.dataset.delTagId)
      render()
    })
  })

  // Tag picker open/close
  document.querySelectorAll('.tag-picker-btn[data-picker-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const key = el.dataset.pickerId + '-' + el.dataset.pickerNs
      if (state.tagPickerOpen === key) {
        state.tagPickerOpen = null
        state.tagPickerPos = null
      } else {
        state.tagPickerOpen = key
        // Position relative to button
        const rect = el.getBoundingClientRect()
        state.tagPickerPos = {
          top: rect.bottom + 6,
          left: Math.min(rect.left, window.innerWidth - 220)
        }
      }
      render()
    })
  })

  // Tag picker checkbox toggle - close after selecting
  document.querySelectorAll('.tag-picker-check[data-pick-tag]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      setTimeout(async () => {
        state.tagPickerOpen = null
        if (el.checked) await addTagToItem(el.dataset.pickTag, el.dataset.tagNs, el.dataset.tagItem)
        else await removeTagFromItem(el.dataset.pickTag, el.dataset.tagNs, el.dataset.tagItem)
      }, 0)
    })
  })

  // Tag picker new inline tag - close after adding
  document.querySelectorAll('.tag-picker-add[data-new-tag-item]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const input = el.closest('.tag-picker-new')?.querySelector('.tag-picker-input')
      const name = input?.value?.trim()
      if (!name) return
      state.tagPickerOpen = null
      await addTagToItem(name, el.dataset.newTagNs, el.dataset.newTagItem)
      if (input) input.value = ''
    })
  })
  document.querySelectorAll('.tag-picker-input').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
    el.addEventListener('keydown', async e => {
      if (e.key === 'Enter') { e.preventDefault(); el.closest('.tag-picker-new')?.querySelector('.tag-picker-add')?.click() }
    })
  })
  // Close picker on outside click - setTimeout prevents immediate firing
  setTimeout(() => {
    document.addEventListener('click', () => {
      if (state.tagPickerOpen) { state.tagPickerOpen = null; render() }
    }, { once: true })
  }, 0)


  // ── CALENDAR HANDLERS ──

  // Week navigation
  document.querySelectorAll('.cal-nav[data-week-nav]').forEach(el => {
    el.addEventListener('click', async () => {
      state.weekOffset += parseInt(el.dataset.weekNav)
      const dates = getWeekDates(state.weekOffset)
      state.mealPlan = await db.fetchMealPlan(dates[0], dates[6])
      render()
    })
  })

  // Open recipe picker for a slot
  document.querySelectorAll('[data-cal-date]').forEach(el => {
    el.addEventListener('click', () => {
      state.calendarSlot = { date: el.dataset.calDate, slot: el.dataset.calSlot }
      state.calendarSearch = ''
      state.calendarTagFilter = null
      render()
      setTimeout(() => document.getElementById('cal-search-input')?.focus(), 50)
    })
  })

  // Tag filter chips in calendar picker
  document.querySelectorAll('[data-cal-tag]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.calendarTagFilter = el.dataset.calTag || null
      render()
      setTimeout(() => document.getElementById('cal-search-input')?.focus(), 50)
    })
  })

  // Calendar search
  document.getElementById('cal-search-input')?.addEventListener('input', e => {
    state.calendarSearch = e.target.value
    render()
  })

  // Pick recipe for calendar slot
  document.querySelectorAll('.cal-recipe-option[data-pick-recipe]').forEach(el => {
    el.addEventListener('click', async () => {
      if (!state.calendarSlot) return
      const { date, slot } = state.calendarSlot
      const saved = await db.saveMealPlanEntry(date, slot, el.dataset.pickRecipe, el.dataset.pickName, '')
      if (saved) state.mealPlan.push(saved)
      state.calendarSlot = null
      state.calendarSearch = ''
      render()
    })
  })

  // Close calendar picker
  document.getElementById('cal-picker-cancel')?.addEventListener('click', () => { state.calendarSlot = null; state.calendarTagFilter = null; render() })
  document.getElementById('cal-picker-bg')?.addEventListener('click', e => { if (e.target.id === 'cal-picker-bg') { state.calendarSlot = null; state.calendarTagFilter = null; render() } })

  // Delete meal plan entry
  document.querySelectorAll('[data-del-plan]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      await db.deleteMealPlanEntry(el.dataset.delPlan)
      state.mealPlan = state.mealPlan.filter(m => m.id !== el.dataset.delPlan)
      render()
    })
  })

  // Log a planned meal from calendar
  document.querySelectorAll('[data-log-plan]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.logModal = { recipeId: el.dataset.planRid || null, recipeName: el.dataset.planName }
      render()
    })
  })

  // Add planned meal's ingredients to shopping list from calendar
  document.querySelectorAll('[data-shop-plan]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const rid = el.dataset.shopPlan
      if (!rid) return
      const r = state.recipes.find(x => String(x.id) === String(rid))
      if (!r) return
      const ingLines = (r.ingredients || r.text || '').split('\n')
        .map(l => l.replace(/^[*\-\d.]+\s*/, '').trim())
        .filter(l => l.length > 2 && l.length < 120)
      const items = ingLines.map(raw => {
        const name = parseIngredientLine(raw)
        const stripped = stripMeasurements(raw)
        const match = state.pantry.find(p => {
          const pl = p.name.toLowerCase()
          return stripped.includes(pl) || pl.includes(stripped.split(' ').filter(w => w.length > 2)[0] || stripped)
        })
        return { name, pantryQty: match ? (match.qty || 'v in pantry') : null, checked: !match }
      })
      state.shopReview = { recipeId: r.id, recipeName: r.name, items }
      render()
    })
  })

  // Log today's meals button
  document.getElementById('log-today-btn')?.addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0,10)
    const todayEntries = state.mealPlan.filter(e => e.date === today)
    for (const entry of todayEntries) {
      const already = state.log.some(l => l.food.includes(entry.recipe_name))
      if (!already) {
        const saved = await db.addLogEntry(entry.recipe_name, 0)
        if (saved) state.log.push(saved)
      }
    }
    state.tab = 'log'
    render()
  })

  // ── LOG SEARCH HANDLERS ──

  document.getElementById('log-search')?.addEventListener('input', e => {
    state.logSearch = e.target.value
    render()
  })
  document.getElementById('log-search-clear')?.addEventListener('click', () => {
    state.logSearch = ''
    state.logTagFilter = null
    state.logSearchFocused = false
    render()
  })
  document.querySelectorAll('[data-log-tag]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.logTagFilter = el.dataset.logTag || null
      render()
    })
  })

  // Log from recipe search result
  document.querySelectorAll('[data-log-recipe][data-log-recipe-name]').forEach(el => {
    el.addEventListener('click', () => {
      state.logModal = { recipeId: el.dataset.logRecipe, recipeName: el.dataset.logRecipeName }
      state.logSearch = ''
      state.logSearchFocused = false
      render()
    })
  })

  // Add calories to a zero-calorie log entry
  document.querySelectorAll('.log-add-cals-btn[data-add-cals-id]').forEach(el => {
    el.addEventListener('click', () => {
      const cals = prompt('How many calories?')
      if (cals && !isNaN(parseInt(cals))) {
        const entry = state.log.find(l => l.id === el.dataset.addCalsId)
        if (entry) {
          entry.calories = parseInt(cals)
          db.updateLogEntry(entry.id, entry.calories)
          render()
        }
      }
    })
  })

  // Go to recipe from log entry
  document.querySelectorAll('.log-recipe-link[data-go-recipe]').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = 'recipes'
      state.expandedRecipe = el.dataset.goRecipe
      render()
    })
  })

  // Click recipe name in calendar to view it
  document.querySelectorAll('[data-go-recipe]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.tab = 'recipes'
      state.expandedRecipe = el.dataset.goRecipe
      render()
    })
  })

  // Add to Week from recipe card
  document.querySelectorAll('[data-add-to-week]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.addToWeekModal = { recipeId: el.dataset.addToWeek, recipeName: el.dataset.addName, selectedDay: null, selectedSlot: null }
      const d = new Date(); state.addToWeekModal.selectedDay = d.toISOString().slice(0, 10)
      render()
    })
  })
  document.querySelectorAll('[data-week-day]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      if (state.addToWeekModal) { state.addToWeekModal.selectedDay = el.dataset.weekDay; render() }
    })
  })
  document.querySelectorAll('[data-week-slot]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      if (state.addToWeekModal) { state.addToWeekModal.selectedSlot = el.dataset.weekSlot; render() }
    })
  })
  document.getElementById('add-week-cancel')?.addEventListener('click', () => { state.addToWeekModal = null; render() })
  document.getElementById('add-week-bg')?.addEventListener('click', e => { if (e.target.id === 'add-week-bg') { state.addToWeekModal = null; render() } })
  document.getElementById('add-week-save')?.addEventListener('click', async () => {
    const m = state.addToWeekModal
    if (!m || !m.selectedSlot) return
    const saved = await db.saveMealPlanEntry(m.selectedDay, m.selectedSlot, m.recipeId, m.recipeName)
    if (saved) {
      if (!state.mealPlan) state.mealPlan = []
      state.mealPlan.push(saved)
    }
    state.addToWeekModal = null
    render()
  })

  // Manual text entry in calendar picker
  document.getElementById('cal-manual-add')?.addEventListener('click', async () => {
    const val = document.getElementById('cal-manual-input')?.value?.trim()
    if (!val || !state.calendarSlot) return
    const { date, slot } = state.calendarSlot
    const saved = await db.saveMealPlanEntry(date, slot, null, val)
    if (saved) state.mealPlan.push(saved)
    state.calendarSlot = null; state.calendarTagFilter = null; render()
  })
  document.getElementById('cal-manual-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('cal-manual-add')?.click()
  })


  // History tab navigation
  document.querySelectorAll('.cal-nav[data-history-nav]').forEach(el => {
    el.addEventListener('click', () => {
      state.historyOffset += parseInt(el.dataset.historyNav)
      if (state.historyOffset > 0) state.historyOffset = 0
      render()
    })
  })


  // ── CHAT HANDLERS ──
  document.getElementById('chat-send')?.addEventListener('click', () => {
    const input = document.getElementById('chat-input')
    const msg = input?.value?.trim()
    if (msg) { input.value = ''; sendChatMessage(msg) }
  })
  document.getElementById('chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const msg = e.target.value?.trim()
      if (msg) { e.target.value = ''; sendChatMessage(msg) }
    }
  })
  document.querySelectorAll('.chat-prompt-chip[data-prompt-text], .chat-starter[data-prompt-text]').forEach(el => {
    el.addEventListener('click', () => sendChatMessage(el.dataset.promptText))
  })
  document.getElementById('chat-clear')?.addEventListener('click', () => {
    state.chatMessages = []
    render()
  })
}

// ── START ─────────────────────────────────────────────────────────────────────
init()

// Re-fetch from Supabase when user switches back to this tab
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    const [recipes, allTags] = await Promise.all([db.fetchRecipes(), db.fetchTags()])
    state.recipes = recipes.map(normalizeRecipe)
    state.allTags = allTags || []
    render()

    // Check clipboard for a recipe URL
    try {
      const text = await navigator.clipboard.readText()
      const trimmed = (text || '').trim()
      const isUrl = trimmed.startsWith('http') && trimmed.length < 500
      const alreadyShown = state._lastClipboardUrl === trimmed
      if (isUrl && !alreadyShown && !state.pasteModal && !state.shareLoading) {
        state._lastClipboardUrl = trimmed
        state.clipboardBanner = trimmed
        render()
      }
    } catch (e) {
      // Clipboard permission denied - that is fine
    }
  }
})
