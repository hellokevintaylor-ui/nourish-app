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
  weekOffset: 0,        // 0 = current week, 1 = next week, -1 = last week
  historyLog: [],       // full log history
  historyOffset: 0,     // week offset for history view
  agentProfile: null,   // computed behavioral profile
  mealPlan: [],         // loaded meal plan entries
  calendarSlot: null,   // { date, slot } when picker is open
  logSearch: '',        // search query in log tab
  logRecipeResults: [], // recipe search results in log
  editingNotes: null,
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
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p && !(p.tags||[]).includes(name)) {
      p.tags = [...(p.tags||[]), name]
      await db.updatePantryTags(p.id, p.tags)
    }
  } else if (namespace === 'location') {
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
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p) { p.tags = (p.tags||[]).filter(t => t !== name); await db.updatePantryTags(p.id, p.tags) }
  } else if (namespace === 'location') {
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

function buildClaudeContext() {
  const recipeList = state.recipes.length === 0 ? 'No recipes saved yet.'
    : state.recipes.map((r,i) => `${i+1}. ${r.name}\nINGREDIENTS:\n${r.ingredients||''}\nINSTRUCTIONS:\n${r.instructions||r.text||''}${r.cookingNotes?`\nMY NOTES: ${r.cookingNotes}`:''}`).join('\n\n')
  const pantryList = state.pantry.length === 0 ? 'Empty.'
    : state.pantry.map(p => p.name + (p.qty ? ' (' + p.qty + ')' : '')).join(', ')
  const logList = state.log.length === 0 ? 'Nothing logged.' : state.log.map(e => `- ${e.food}: ${e.calories} cal`).join('\n')
  return `My Nourish Data:

GOALS: ${state.goals.calories} cal/day | Protein ${state.goals.protein}g | Carbs ${state.goals.carbs}g | Fat ${state.goals.fat}g | Goal: ${GOAL_PRESETS[state.goals.goal]?.label}

TODAY'S LOG:
${logList}
Total: ${todayCalories()} / ${state.goals.calories} cal

PANTRY: ${pantryList}

SAVED RECIPES (${state.recipes.length}):
${recipeList}`
}

function openClaude(prompt) {
  const url = `https://claude.ai/new?q=${encodeURIComponent(buildClaudeContext() + '\n\n---\n\n' + (prompt || 'Help me with my meal planning this week.'))}`
  window.open(url, '_blank')
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

  app.innerHTML = `
    <div class="layout">
      <!-- HEADER -->
      <div class="header">
        <div class="header-title"><em>Mise en Place</em></div>
        <div class="header-right">
          ${cals > 0 ? '<div class="header-cal">Today: ' + cals + ' cal</div>' : ''}
        <button class="icon-btn" id="paste-btn">&#128203; Paste Recipe</button>
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
        <div class="sync-title">&#128279; Sync Devices</div>
        <div class="sync-hint">Use the same Account ID on all your devices and browsers to share recipes, pantry and lists.</div>
        <div class="sync-id-box">
          <div class="sync-id-label">Your Account ID</div>
          <div class="sync-id-value" id="sync-id-display">${getUserId()}</div>
          <button class="sync-copy-btn" id="sync-copy-btn">Copy</button>
        </div>
        <div class="sync-switch-box">
          <div class="sync-id-label">Switch to a different Account ID</div>
          <div class="sync-input-row">
            <input id="sync-input" placeholder="Paste Account ID here..." />
            <button class="add-btn" id="sync-switch-btn">Switch</button>
          </div>
          <div class="sync-warning">&#9888; This will replace your current data with that account's data.</div>
        </div>
      </div>` : ""}

      <!-- TABS -->
      <div class="tabs">
        <div class="tab ${state.tab==='recipes'?'active':''}" data-tab="recipes">Recipes${state.recipes.length>0?'<span class="tab-badge">'+state.recipes.length+'</span>':''}</div>
        <div class="tab ${state.tab==='pantry'?'active':''}" data-tab="pantry">🧺 Pantry${state.pantry.length>0?'<span class="tab-badge">'+state.pantry.length+'</span>':''}</div>
        <div class="tab ${state.tab==='shop'?'active':''}" data-tab="shop">🛒 List${needCount>0?'<span class="tab-badge">'+needCount+'</span>':''}</div>
        <div class="tab ${state.tab==='log'?'active':''}" data-tab="log">Log</div>
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
      ${state.shopReview    ? renderShopReview()    : ''}
      ${state.logModal      ? renderLogModal()      : ''}
    </div>
  `
  bindEvents()
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
    '<div class="tag-picker-popover">' +
    mealTags.map(t => {
      const checked = (r.tags||[]).includes(t.name)
      return '<label class="tag-picker-option">' +
        '<input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe" ' + (checked?'checked':'') + ' />' +
        esc(t.name) + '</label>'
    }).join('') +
    '<div class="tag-picker-new">' +
      '<input class="tag-picker-input" id="new-tag-' + r.id + '-meal" placeholder="New tag..." />' +
      '<button class="tag-picker-add" data-new-tag-item="' + r.id + '" data-new-tag-ns="meal">Add</button>' +
    '</div>' +
    '</div>'
  ) : ''

  const body = '<div class="recipe-body">' +
    (r.clippedFrom ? '<div class="recipe-link"><a href="' + esc(r.clippedFrom) + '" target="_blank">&#128279; View original</a></div>' : '') +
    (r.ingredients ? '<div class="recipe-section-label">Ingredients</div><div class="recipe-text">' + formatRecipeText(r.ingredients) + '</div>' : '') +
    (r.instructions ? '<div class="recipe-section-label">Instructions</div><div class="recipe-text">' + formatRecipeText(r.instructions) + '</div>' : '') +
    '<div class="recipe-section-label cooking-notes-label">My Cooking Notes' +
      '<button class="notes-edit-btn" data-notes-edit="' + r.id + '">' + (state.editingNotes===r.id?'Done':'Edit') + '</button>' +
    '</div>' +
    notesSection +
    '<div class="tag-row">' + tagChips + tagPickerBtn + '</div>' +
    tagPicker +
    '<div class="recipe-actions">' +
      '<button class="ra-btn ra-shop" data-shop="' + r.id + '">🛒 Add to list</button>' +
      '<button class="ra-btn ra-log" data-log-recipe="' + r.id + '">&#127373; Log meal</button>' +
      '<button class="ra-btn ra-ask" data-ask="' + r.id + '">💬 Ask AI</button>' +
      '<button class="ra-btn ra-del" data-del="' + r.id + '">🗑</button>' +
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
  return `
    <div class="tab-content">
      <div class="section-title">My Pantry</div>
      ${state.allTags.some(t => t.namespace === 'location') ? renderTagFilterChips('location', 'Pantry') : ''}
      <div class="pantry-hint">Add items with quantities - tap the qty field to update anytime.</div>
      <div class="pantry-add-box">
        <div class="pantry-add-row">
          <input id="pantry-name" placeholder="Item name" style="flex:2" />
          <input id="pantry-qty"  placeholder="Qty (2 cans)" style="flex:1" />
          <button class="add-btn" id="pantry-add-btn">+ Add</button>
        </div>
      </div>
      ${state.pantry.length === 0 ? `
        <div class="empty-state">Your pantry is empty.<br>Add staples you keep on hand! 🧺</div>
      ` : `
        <div class="pantry-list">
          ${state.pantry.map(item => {
            const chips = (item.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + item.id + '" data-tag-ns="location">×</button></span>').join('')
            const pickerId = item.id + '-location'
            const isOpen = state.tagPickerOpen === pickerId
            const pantryTags = getTagsForNamespace('location')
            const picker = isOpen ? ('<div class="tag-picker-popover">' + pantryTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + item.id + '" data-tag-ns="location" ' + ((item.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + item.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + item.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
            return '<div class="pantry-row pantry-row-wrap">' +
              '<div class="pantry-row-main">' +
                '<div class="pantry-row-name">' + esc(item.name) + '</div>' +
                '<input class="pantry-qty-input" data-qty-id="' + item.id + '" value="' + esc(item.qty||'') + '" placeholder="qty" />' +
                '<button class="remove-btn" data-pantry-del="' + item.id + '">×</button>' +
              '</div>' +
              '<div class="pantry-row-tags">' + chips + '<button class="tag-picker-btn" data-picker-id="' + item.id + '" data-picker-ns="location">+ Tag</button>' + picker + '</div>' +
            '</div>'
          }).join('')}
        </div>
        <button class="clear-pantry-btn" id="clear-pantry">Clear all</button>
      `}
    </div>`
}

function renderShop() {
  const need = state.shopList.filter(i => !i.have)
  const got  = state.shopList.filter(i => i.have)
  const byRecipe = {}
  need.forEach(i => { if (!byRecipe[i.fromRecipe||'Other']) byRecipe[i.fromRecipe||'Other'] = []; byRecipe[i.fromRecipe||'Other'].push(i) })

  return `
    <div class="tab-content">
      <div class="shop-header">
        <div class="section-title">Shopping List</div>
        ${state.shopList.length > 0 ? `
          <div style="display:flex;gap:6px">
            <button class="icon-btn" id="shop-copy-btn">&#128203; Copy</button>
            <button class="clear-pantry-btn" id="shop-clear">Clear</button>
          </div>` : ''}
      </div>
      ${state.shopList.length === 0 ? `
        <div class="empty-state">Your list is empty.<br>Open a recipe and tap <strong>Add to list</strong>! 🛒</div>
      ` : ''}
      ${state.allTags.some(t => t.namespace === 'location') ? renderTagFilterChips('location', 'Store') : ''}
      ${need.length > 0 ? `
        <div class="shop-got-it-bar">
          <div class="shop-got-it-text">${need.length} item${need.length!==1?'s':''} to buy</div>
          <button class="shop-got-it-btn" id="shop-got-it">✅ Got it all!</button>
        </div>
        ${Object.entries(byRecipe).map(([recipe, items]) => `
          <div class="shop-recipe-group">
            <div class="shop-recipe-name">📄 ${esc(recipe)}</div>
            ${items.map(i => {
                const chips = (i.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + i.id + '" data-tag-ns="location">×</button></span>').join('')
                const pickerId = i.id + '-location'
                const isOpen = state.tagPickerOpen === pickerId
                const storeTags = getTagsForNamespace('location')
                const picker = isOpen ? ('<div class="tag-picker-popover">' + storeTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + i.id + '" data-tag-ns="location" ' + ((i.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + i.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + i.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
                return '<div class="shop-row">' +
                  '<div class="shop-check" data-check="' + i.id + '"></div>' +
                  '<div class="shop-item-main">' +
                    '<div class="shop-item-name">' + esc(i.name) + '</div>' +
                    '<div class="shop-item-tags">' + chips + '<button class="tag-picker-btn" data-picker-id="' + i.id + '" data-picker-ns="location">+ Tag</button>' + picker + '</div>' +
                  '</div>' +
                  '<button class="remove-btn" data-shop-del="' + i.id + '">×</button>' +
                '</div>'
              }).join('')}
          </div>
        `).join('')}
      ` : ''}
      ${got.length > 0 ? `
        <div class="shop-got-section">
          <div class="shop-section-label">Got ✓</div>
          ${got.map(i => `
            <div class="shop-row shop-row-got">
              <div class="shop-check shop-check-done" data-uncheck="${i.id}">✓</div>
              <div class="shop-item-name shop-item-got">${esc(i.name)}</div>
              <button class="remove-btn" data-shop-del="${i.id}">×</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="shop-add-row">
        <input id="shop-manual-input" placeholder="Add item manually..." />
        <button class="add-btn" id="shop-manual-add">+ Add</button>
      </div>
    </div>`
}

function renderLog() {
  const cals = todayCalories()
  const rem = state.goals.calories - cals
  const search = state.logSearch || ''
  const recipeResults = search ? state.recipes.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).slice(0,6) : []

  const logEntries = state.log.length === 0
    ? '<div class="empty-state">Nothing logged yet today!</div>'
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
          (e.recipe_id ? '<button class="log-recipe-link" data-go-recipe="' + e.recipe_id + '">📖</button>' : '') +
          '<button class="remove-btn" data-log-del="' + e.id + '">×</button>' +
        '</div>'
      ).join('')

  return '<div class="tab-content">' +
    '<div class="log-total">' +
      '<div>' +
        '<div class="log-total-label">Calories today</div>' +
        '<div class="log-total-sub">' + (rem > 0 ? rem + ' remaining' : Math.abs(rem) + ' over goal') + '</div>' +
      '</div>' +
      '<div><span class="log-total-val">' + cals + '</span><span class="log-total-goal"> / ' + state.goals.calories + '</span></div>' +
    '</div>' +
    '<div class="log-search-wrap">' +
      '<input id="log-search" class="log-search-input" placeholder="&#128269; Search recipes to log..." value="' + esc(search) + '" />' +
      (recipeResults.length ? '<div class="log-search-results">' +
        recipeResults.map(r =>
          '<button class="log-search-result" data-log-recipe="' + r.id + '" data-log-recipe-name="' + esc(r.name) + '">' + esc(r.name) + '</button>'
        ).join('') +
      '</div>' : '') +
    '</div>' +
    '<div class="log-add-row">' +
      '<input id="log-food" placeholder="Or type food name manually..." />' +
      '<input id="log-cals" type="number" placeholder="Cal" style="max-width:70px" />' +
      '<button class="add-btn" id="log-add-btn">+ Add</button>' +
    '</div>' +
    logEntries +
  '</div>'
}



// ── WEEK HELPERS ─────────────────────────────────────────────────────────────
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
        html += '<span class="cal-entry-name">' + esc(entry.recipe_name || 'Unnamed') + '</span>'
        html += '<div class="cal-entry-actions">'
        html += '<button class="cal-entry-log" data-log-plan="' + entry.id + '" data-plan-name="' + esc(entry.recipe_name) + '" data-plan-rid="' + (entry.recipe_id||'') + '">+ Log</button>'
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
    const results = search
      ? state.recipes.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8)
      : state.recipes.slice(0, 8)

    html += '<div class="modal-bg" id="cal-picker-bg">'
    html += '<div class="modal-sheet">'
    html += '<div class="modal-title">Add to ' + slot + '</div>'
    html += '<div class="modal-sub">' + formatDate(date) + '</div>'
    html += '<input id="cal-search-input" class="cal-search" placeholder="Search recipes..." value="' + esc(search) + '" />'
    html += '<div class="cal-recipe-list">'
    if (results.length === 0) {
      html += '<div class="empty-state" style="padding:20px">No recipes found</div>'
    } else {
      results.forEach(r => {
        html += '<button class="cal-recipe-option" data-pick-recipe="' + r.id + '" data-pick-name="' + esc(r.name) + '">' + esc(r.name) + '</button>'
      })
    }
    html += '</div>'
    html += '<div class="modal-btns"><button class="modal-cancel" id="cal-picker-cancel">Cancel</button></div>'
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
  const prompts = [
    { icon: '&#128203;', label: 'Weekly meal plan', text: 'Plan my meals for the week using my saved recipes' },
    { icon: '🔄', label: 'Use my recipes',   text: 'What can I make with my saved recipes this week?' },
    { icon: '🎯', label: "Today's plan",     text: "What should I eat today to hit my goals?" },
    { icon: '🛒', label: 'Meal prep list',   text: 'Give me a meal prep plan and shopping list for the week' },
    { icon: '🍳', label: 'Breakfast ideas',  text: 'Give me 5 high-protein breakfasts under 400 calories' },
  ]
  return `
    <div class="tab-content">
      <div class="claude-banner">
        <div class="claude-banner-text">
          <div class="claude-banner-title">AI Chat via Claude.ai</div>
          <div class="claude-banner-sub">Opens with your recipes, pantry & goals pre-loaded</div>
        </div>
        <button class="claude-open-btn" id="open-claude-btn">Open Claude ↗</button>
      </div>
      <div class="quick-prompts-grid">
        ${prompts.map((p,i) => '<button class="prompt-card" data-prompt="' + i + '" data-text="' + esc(p.text) + '">' + p.icon + '<span>' + p.label + '</span></button>').join('')}
      </div>
      <div class="claude-input-row">
        <input id="claude-input" placeholder="Or type your own question..." />
        <button class="add-btn" id="claude-send-btn">↗</button>
      </div>
      <div class="claude-how">
        <div class="claude-how-step">1. Pick a prompt or type your own</div>
        <div class="claude-how-step">2. Claude opens with ALL your data already loaded</div>
        <div class="claude-how-step">3. Ask for meal plans, recipe edits, ingredient ideas - anything</div>
      </div>
    </div>`
}

// ── MODALS ────────────────────────────────────────────────────────────────────
function renderPasteModal() {
  return `
    <div class="modal-bg" id="paste-modal-bg">
      <div class="modal-sheet">
        <div class="modal-title">&#128203; Paste a Recipe</div>
        <div class="modal-sub">From YouTube, Instagram, a comment, anywhere</div>
        <input id="paste-name" placeholder="Recipe name" />
        <textarea id="paste-text" style="min-height:160px" placeholder="Paste the recipe text - ingredients, instructions, however messy. Edit before saving."></textarea>
        <div class="modal-btns">
          <button class="modal-cancel" id="paste-cancel">Cancel</button>
          <button class="modal-save" id="paste-save">Save to Recipe Box</button>
        </div>
      </div>
    </div>`
}

function renderShopReview() {
  const s = state.shopReview
  return `
    <div class="modal-bg" id="shop-review-bg">
      <div class="modal-sheet">
        <div class="modal-title">🛒 What do you need?</div>
        <div class="modal-sub">${esc(s.recipeName)}</div>
        <div class="shop-review-hint">Pre-checked items aren't in your pantry. Adjust as needed.</div>
        <div class="shop-review-list">
          ${s.items.map((item,idx) => `
            <label class="shop-review-row">
              <input type="checkbox" class="shop-review-check" data-idx="${idx}" ${item.checked?'checked':''} />
              <div class="shop-review-info">
                <div class="shop-review-name">${esc(item.name)}</div>
                ${item.pantryQty ? '<div class="shop-review-have">You have: ' + esc(item.pantryQty) + '</div>' : '<div class="shop-review-none">Not in pantry</div>'}
              </div>
            </label>
          `).join('')}
        </div>
        <div class="modal-btns">
          <button class="modal-cancel" id="shop-review-cancel">Cancel</button>
          <button class="modal-save" id="shop-review-add">Add to Shopping List</button>
        </div>
      </div>
    </div>`
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
      if (r) openClaude(`Tell me ways I can use this recipe throughout the week:\n\n${r.name}\n${r.text}`)
    })
  })

  // Pantry
  document.getElementById('pantry-add-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('pantry-name')?.value?.trim()
    const qty  = document.getElementById('pantry-qty')?.value?.trim()
    if (!name) return
    const saved = await db.addPantryItem(name, qty)
    if (saved) state.pantry.push(saved)
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
      const items = ingLines.map(name => {
        const stripped = stripMeasurements(name)
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
    const text = Object.entries(need.reduce((g,i) => { const k=i.fromRecipe||'Other'; if(!g[k])g[k]=[]; g[k].push(i.name); return g }, {}))
      .map(([r,items]) => r + ':\n' + items.map(n => '• ' + n).join('\n')).join('\n\n')
    navigator.clipboard.writeText(text).then(() => alert('Shopping list copied!'))
  })
  document.getElementById('shop-manual-add')?.addEventListener('click', async () => {
    const val = document.getElementById('shop-manual-input')?.value?.trim()
    if (!val) return
    const saved = await db.addShopItem(val, 'Manual')
    if (saved) state.shopList.push({ ...saved, fromRecipe: 'Manual' })
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

  // Ask Claude for calorie estimate
  document.getElementById('lm-estimate')?.addEventListener('click', () => {
    const portion = document.getElementById('lm-portion')?.value?.trim()
    const recipe = state.logModal.recipeId ? state.recipes.find(r => String(r.id) === String(state.logModal.recipeId)) : null
    if (!recipe) return
    const q = portion
      ? "How many calories in " + portion + " of this recipe? Just give me a single number.\n\nRecipe: " + recipe.name + "\nIngredients: " + (recipe.ingredients || "")
      : "How many calories per serving of this recipe?\n\nRecipe: " + recipe.name + "\nIngredients: " + (recipe.ingredients || "")
    window.open("https://claude.ai/new?q=" + encodeURIComponent(q), "_blank")
    // Update note without full re-render to preserve event listeners
    const noteEl = document.querySelector('.modal-note')
    if (noteEl) noteEl.textContent = "Claude opened - come back and enter the number here!"
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
  document.getElementById('paste-cancel')?.addEventListener('click', () => { state.pasteModal = false; render() })
  document.getElementById('paste-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'paste-modal-bg') { state.pasteModal = false; render() } })
  document.getElementById('paste-save')?.addEventListener('click', async () => {
    const name = document.getElementById('paste-name')?.value?.trim()
    const text = document.getElementById('paste-text')?.value?.trim()
    if (!name || !text) return
    const lower = text.toLowerCase()
    let ingredients = text, instructions = ''
    const splitMatch = text.match(/^([\s\S]*?)(?:instructions?|directions?|steps?|method|how to make)[:\s]*([\s\S]*)$/i)
    if (splitMatch) { ingredients = splitMatch[1].replace(/ingredients?[:\s]*/i,'').trim(); instructions = splitMatch[2].trim() }
    const saved = await db.saveRecipe({ name, ingredients, instructions, notes: '' })
    if (saved) state.recipes.unshift(normalizeRecipe(saved))
    state.pasteModal = false; state.tab = 'recipes'; render()
  })

  // Chat / Claude launcher
  document.getElementById('open-claude-btn')?.addEventListener('click', () => openClaude(''))
  document.querySelectorAll('[data-prompt]').forEach(el => {
    el.addEventListener('click', () => openClaude(el.dataset.text))
  })
  document.getElementById('claude-send-btn')?.addEventListener('click', () => {
    const val = document.getElementById('claude-input')?.value?.trim()
    openClaude(val || '')
  })
  document.getElementById('claude-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('claude-send-btn')?.click()
  })


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
      state.tagPickerOpen = state.tagPickerOpen === key ? null : key
      render()
    })
  })

  // Tag picker checkbox toggle
  document.querySelectorAll('.tag-picker-check[data-pick-tag]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      // Use setTimeout to let checkbox state update before reading it
      setTimeout(async () => {
        if (el.checked) await addTagToItem(el.dataset.pickTag, el.dataset.tagNs, el.dataset.tagItem)
        else await removeTagFromItem(el.dataset.pickTag, el.dataset.tagNs, el.dataset.tagItem)
      }, 0)
    })
  })
  // Prevent label clicks from closing picker
  document.querySelectorAll('.tag-picker-option').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
  })

  // Tag picker new inline tag
  document.querySelectorAll('.tag-picker-add[data-new-tag-item]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const input = document.getElementById('new-tag-' + el.dataset.newTagItem + '-' + el.dataset.newTagNs)
      const name = input?.value?.trim()
      if (!name) return
      await addTagToItem(name, el.dataset.newTagNs, el.dataset.newTagItem)
      if (input) input.value = ''
    })
  })
  document.querySelectorAll('.tag-picker-input').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
    el.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        el.closest('.tag-picker-popover')?.querySelector('.tag-picker-add')?.click()
      }
    })
  })
  document.querySelectorAll('.tag-picker-popover').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
  })


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
  document.getElementById('cal-picker-cancel')?.addEventListener('click', () => { state.calendarSlot = null; render() })
  document.getElementById('cal-picker-bg')?.addEventListener('click', e => { if (e.target.id === 'cal-picker-bg') { state.calendarSlot = null; render() } })

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

  // Log from recipe search result
  document.querySelectorAll('[data-log-recipe][data-log-recipe-name]').forEach(el => {
    el.addEventListener('click', () => {
      state.logModal = { recipeId: el.dataset.logRecipe, recipeName: el.dataset.logRecipeName }
      state.logSearch = ''
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


  // History tab navigation
  document.querySelectorAll('.cal-nav[data-history-nav]').forEach(el => {
    el.addEventListener('click', () => {
      state.historyOffset += parseInt(el.dataset.historyNav)
      if (state.historyOffset > 0) state.historyOffset = 0
      render()
    })
  })
}

// ── START ─────────────────────────────────────────────────────────────────────
init()

// Ensure wheel events reach the content scroller
document.addEventListener('wheel', (e) => {
  const contentEl = document.querySelector('.content')
  if (contentEl && contentEl.contains(e.target)) {
    contentEl.scrollTop += e.deltaY
  }
}, { passive: true })
