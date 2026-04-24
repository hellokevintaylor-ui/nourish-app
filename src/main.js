import * as db from './db.js'
import { getUserId } from './supabase.js'

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tab: 'recipes',
  recipes: [], pantry: [], shopList: [], log: [],
  goals: { calories: 2000, protein: 150, carbs: 200, fat: 65, goal: 'maintain' },
  loading: true,
  showGoals: false,
  showSync: false,
  expandedRecipe: null,
  activeCategory: 'All',
  allTags: [],
  activeTagFilter: null,
  tagInput: { recipes: '', pantry: '', shop: '' },
  editingNotes: null,
  shopReview: null,
  pasteModal: false,
  addRecipeModal: false,
  logModal: null,
}

const GOAL_PRESETS = {
  lose:     { calories: 1600, protein: 160, carbs: 150, fat: 55,  label: 'Lose Weight' },
  maintain: { calories: 2000, protein: 150, carbs: 200, fat: 65,  label: 'Maintain' },
  gain:     { calories: 2500, protein: 180, carbs: 280, fat: 80,  label: 'Build Muscle' },
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function addTagToItem(name, namespace, itemId) {
  // Save tag to tag library
  const savedTag = await db.saveTag(name, namespace)
  if (savedTag && !state.allTags.find(t => t.name === name && t.namespace === namespace)) {
    state.allTags.push(savedTag)
  }

  if (namespace === 'meal') {
    const r = state.recipes.find(x => String(x.id) === String(itemId))
    if (r && !(r.tags||[]).includes(name)) {
      r.tags = [...(r.tags||[]), name]
      await db.updateRecipeTags(r.id, r.tags)
    }
  } else if (namespace === 'pantry') {
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p && !(p.tags||[]).includes(name)) {
      p.tags = [...(p.tags||[]), name]
      await db.updatePantryTags(p.id, p.tags)
    }
  } else if (namespace === 'store') {
    const s = state.shopList.find(x => String(x.id) === String(itemId))
    if (s && !(s.tags||[]).includes(name)) {
      s.tags = [...(s.tags||[]), name]
      await db.updateShopItemTags(s.id, s.tags)
    }
  }
  render()
}

async function removeTagFromItem(name, namespace, itemId) {
  if (namespace === 'meal') {
    const r = state.recipes.find(x => String(x.id) === String(itemId))
    if (r) { r.tags = (r.tags||[]).filter(t => t !== name); await db.updateRecipeTags(r.id, r.tags) }
  } else if (namespace === 'pantry') {
    const p = state.pantry.find(x => String(x.id) === String(itemId))
    if (p) { p.tags = (p.tags||[]).filter(t => t !== name); await db.updatePantryTags(p.id, p.tags) }
  } else if (namespace === 'store') {
    const s = state.shopList.find(x => String(x.id) === String(itemId))
    if (s) { s.tags = (s.tags||[]).filter(t => t !== name); await db.updateShopItemTags(s.id, s.tags) }
  }
  render()
}

async function init() {
  render()
  const [recipes, pantry, shopList, log, goals, allTags] = await Promise.all([
    db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals(), db.fetchTags()
  ])
  state.allTags = allTags || []
  state.recipes  = recipes.map(normalizeRecipe)
  state.pantry   = pantry
  state.shopList = shopList.map(i => ({ ...i, fromRecipe: i.from_recipe }))
  state.log      = log
  if (goals) state.goals = { calories: goals.calories, protein: goals.protein, carbs: goals.carbs, fat: goals.fat, goal: goals.goal_type }
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
        <div class="header-title">Nourish<span>.</span></div>
        <div class="header-right">
          <button class="icon-btn" id="paste-btn">📋 Paste Recipe</button>
          <button class="icon-btn" id="sync-toggle">🔗 Sync</button>
          <button class="icon-btn ${state.showGoals?'active':''}" id="goals-toggle">⚙ Goals</button>
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
        <div class="sync-title">🔗 Sync Devices</div>
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
          <div class="sync-warning">⚠️ This will replace your current data with that account's data.</div>
        </div>
      </div>` : ""}

      <!-- TABS -->
      <div class="tabs">
        <div class="tab ${state.tab==='recipes'?'active':''}" data-tab="recipes">🍽 Recipes${state.recipes.length>0?'<span class="tab-badge">'+state.recipes.length+'</span>':''}</div>
        <div class="tab ${state.tab==='pantry'?'active':''}" data-tab="pantry">🧺 Pantry${state.pantry.length>0?'<span class="tab-badge">'+state.pantry.length+'</span>':''}</div>
        <div class="tab ${state.tab==='shop'?'active':''}" data-tab="shop">🛒 List${needCount>0?'<span class="tab-badge">'+needCount+'</span>':''}</div>
        <div class="tab ${state.tab==='log'?'active':''}" data-tab="log">📋 Log</div>
        <div class="tab ${state.tab==='chat'?'active':''}" data-tab="chat">💬 AI</div>
      </div>

      <!-- STATS BAR -->
      <div class="stats-bar">
        <div class="stat">
          <div class="stat-val">${cals}</div>
          <div class="stat-label">Calories</div>
          <div class="progress-bar"><div class="progress-fill ${calCls}" style="width:${calPct}%"></div></div>
        </div>
        ${['protein','carbs','fat'].map(f => `
          <div class="stat">
            <div class="stat-val">0g</div>
            <div class="stat-label">${f}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
          </div>
        `).join('')}
      </div>

      <!-- CONTENT -->
      <div class="content">
        ${state.loading ? '<div class="loading"><div class="spinner"></div><div>Loading your data…</div></div>' : ''}
        ${!state.loading && state.tab === 'recipes' ? renderRecipes() : ''}
        ${!state.loading && state.tab === 'pantry'  ? renderPantry()  : ''}
        ${!state.loading && state.tab === 'shop'    ? renderShop()    : ''}
        ${!state.loading && state.tab === 'log'     ? renderLog()     : ''}
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

function renderTagFilterChips(namespace, label) {
  const tags = getTagsForNamespace(namespace)
  if (!tags.length) return ''
  return '<div class="tag-filter-row">' +
    '<button class="tag-filter-chip ' + (!state.activeTagFilter ? 'active' : '') + '" data-filter-tag="" data-filter-ns="' + namespace + '">All</button>' +
    tags.map(t => '<button class="tag-filter-chip ' + (state.activeTagFilter === t.name ? 'active' : '') + '" data-filter-tag="' + esc(t.name) + '" data-filter-ns="' + namespace + '">' + esc(t.name) + '</button>').join('') +
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
        (r.clippedFrom ? '<div class="recipe-meta">📎 ' + esc((() => { try { return new URL(r.clippedFrom).hostname.replace('www.','') } catch(e) { return '' } })()) + '</div>' : '') +
      '</div>' +
      '<div class="chevron ' + (isExpanded ? 'open' : '') + '">▼</div>' +
    '</div>'

  if (!isExpanded) return header + '</div>'

  const notesSection = state.editingNotes === r.id
    ? '<textarea class="notes-textarea" id="notes-ta-' + r.id + '" placeholder="What worked, what to change, substitutions...">' + esc(r.cookingNotes||'') + '</textarea>' +
      '<button class="notes-save-btn" data-notes-save="' + r.id + '">Save Notes</button>'
    : '<div class="notes-display ' + (!r.cookingNotes ? 'notes-empty' : '') + '">' + (r.cookingNotes ? esc(r.cookingNotes) : 'No notes yet!') + '</div>'

  const tagChips = renderTagChips(r.tags, r.id, 'meal')
  const tagInput = renderTagInput(r.id, 'meal', r.tags)

  const body = '<div class="recipe-body">' +
    (r.clippedFrom ? '<div class="recipe-link"><a href="' + esc(r.clippedFrom) + '" target="_blank">🔗 View original</a></div>' : '') +
    (r.ingredients ? '<div class="recipe-section-label">Ingredients</div><div class="recipe-text">' + formatRecipeText(r.ingredients) + '</div>' : '') +
    (r.instructions ? '<div class="recipe-section-label">Instructions</div><div class="recipe-text">' + formatRecipeText(r.instructions) + '</div>' : '') +
    '<div class="recipe-section-label cooking-notes-label">My Cooking Notes' +
      '<button class="notes-edit-btn" data-notes-edit="' + r.id + '">' + (state.editingNotes===r.id?'Done':'Edit') + '</button>' +
    '</div>' +
    notesSection +
    '<div class="recipe-section-label">Meal Tags</div>' +
    '<div class="tag-chips-row">' + tagChips + '</div>' +
    tagInput +
    '<div class="recipe-actions">' +
      '<button class="ra-btn ra-shop" data-shop="' + r.id + '">🛒 Add to list</button>' +
      '<button class="ra-btn ra-log" data-log-recipe="' + r.id + '">🍽 Log meal</button>' +
      '<button class="ra-btn ra-ask" data-ask="' + r.id + '">💬 Ask AI</button>' +
      '<button class="ra-btn ra-del" data-del="' + r.id + '">🗑</button>' +
    '</div>' +
  '</div>'

  return header + body + '</div>'
}

function renderRecipes() {
  const filtered = state.activeTagFilter ? state.recipes.filter(r => (r.tags||[]).includes(state.activeTagFilter)) : state.recipes
  return `
    <div class="tab-content">
      <div class="section-header">
        <div class="section-title">My Recipe Box</div>
        <button class="add-btn" id="add-recipe-btn">+ Add Recipe</button>
      </div>
      ${state.allTags.some(t => t.namespace === 'meal') ? renderTagFilterChips('meal', 'Meal') : ''}
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
      ${state.allTags.some(t => t.namespace === 'pantry') ? renderTagFilterChips('pantry', 'Pantry') : ''}
      <div class="pantry-hint">Add items with quantities — tap the qty field to update anytime.</div>
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
          ${state.pantry.map(item => `
            <div class="pantry-row">
              <div class="pantry-row-name">${esc(item.name)}</div>
              <input class="pantry-qty-input" data-qty-id="${item.id}" value="${esc(item.qty||'')}" placeholder="qty" />
              <button class="remove-btn" data-pantry-del="${item.id}">×</button>
            </div>
          `).join('')}
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
            <button class="icon-btn" id="shop-copy-btn">📋 Copy</button>
            <button class="clear-pantry-btn" id="shop-clear">Clear</button>
          </div>` : ''}
      </div>
      ${state.shopList.length === 0 ? `
        <div class="empty-state">Your list is empty.<br>Open a recipe and tap <strong>Add to list</strong>! 🛒</div>
      ` : ''}
      ${state.allTags.some(t => t.namespace === 'store') ? renderTagFilterChips('store', 'Store') : ''}
      ${need.length > 0 ? `
        <div class="shop-got-it-bar">
          <div class="shop-got-it-text">${need.length} item${need.length!==1?'s':''} to buy</div>
          <button class="shop-got-it-btn" id="shop-got-it">✅ Got it all!</button>
        </div>
        ${Object.entries(byRecipe).map(([recipe, items]) => `
          <div class="shop-recipe-group">
            <div class="shop-recipe-name">📄 ${esc(recipe)}</div>
            ${items.map(i => `
              <div class="shop-row">
                <div class="shop-check" data-check="${i.id}"></div>
                <div class="shop-item-name">${esc(i.name)}</div>
                <button class="remove-btn" data-shop-del="${i.id}">×</button>
              </div>
            `).join('')}
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
  return `
    <div class="tab-content">
      <div class="log-total">
        <div>
          <div class="log-total-label">Calories today</div>
          <div class="log-total-sub">${rem > 0 ? rem + ' remaining' : Math.abs(rem) + ' over goal'}</div>
        </div>
        <div><span class="log-total-val">${cals}</span><span class="log-total-goal"> / ${state.goals.calories}</span></div>
      </div>
      <div class="log-add-row">
        <input id="log-food" placeholder="Food name" />
        <input id="log-cals" type="number" placeholder="Cal" style="max-width:70px" />
        <button class="add-btn" id="log-add-btn">+ Add</button>
      </div>
      ${state.log.length === 0 ? '<div class="empty-state">Nothing logged yet today!</div>' :
        state.log.map(e => `
          <div class="log-entry">
            <div><div class="log-food">${esc(e.food)}</div><div class="log-cal">${e.calories} kcal</div></div>
            <button class="remove-btn" data-log-del="${e.id}">×</button>
          </div>
        `).join('')}
    </div>`
}

function renderChat() {
  const prompts = [
    { icon: '📋', label: 'Weekly meal plan', text: 'Plan my meals for the week using my saved recipes' },
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
        <div class="claude-how-step">3. Ask for meal plans, recipe edits, ingredient ideas — anything</div>
      </div>
    </div>`
}

// ── MODALS ────────────────────────────────────────────────────────────────────
function renderPasteModal() {
  return `
    <div class="modal-bg" id="paste-modal-bg">
      <div class="modal-sheet">
        <div class="modal-title">📋 Paste a Recipe</div>
        <div class="modal-sub">From YouTube, Instagram, a comment, anywhere</div>
        <input id="paste-name" placeholder="Recipe name" />
        <textarea id="paste-text" style="min-height:160px" placeholder="Paste the recipe text — ingredients, instructions, however messy. Edit before saving."></textarea>
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
  return `
    <div class="modal-bg" id="log-modal-bg">
      <div class="modal-sheet">
        <div class="modal-title">🍽 Log a serving</div>
        <div class="modal-sub">${esc(m.recipeName)}</div>
        <input id="lm-portion" placeholder='How much? (e.g. "1 cup", "2 servings")' />
        <input id="lm-cals" type="number" placeholder="Calories (leave blank to estimate)" />
        <div class="modal-note">💡 Not sure? Leave calories blank and ask AI to estimate!</div>
        <div class="modal-btns">
          <button class="modal-cancel" id="lm-cancel">Cancel</button>
          <button class="modal-save" id="lm-save">Add to Log</button>
        </div>
      </div>
    </div>`
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

  // Filter chips
  document.querySelectorAll('.tag-filter-chip[data-filter-tag]').forEach(el => {
    el.addEventListener('click', () => {
      state.activeTagFilter = el.dataset.filterTag || null
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
    if (!confirm('Switch to this account? Your current local data will be replaced with that account\'s data.')) return;
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
    if (goals) state.goals = { calories: goals.calories, protein: goals.protein, carbs: goals.carbs, fat: goals.fat, goal: goals.goal_type };
    state.loading  = false;
    render();
  })
  document.querySelectorAll('.preset-btn[data-preset]').forEach(el => {
    el.addEventListener('click', async () => {
      const p = GOAL_PRESETS[el.dataset.preset]
      state.goals = { ...p, goal: el.dataset.preset }
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
  document.querySelectorAll('[data-log-recipe]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const r = state.recipes.find(x => x.id === el.dataset.logRecipe)
      if (r) { state.logModal = { recipeId: r.id, recipeName: r.name }; render() }
    })
  })
  document.getElementById('lm-cancel')?.addEventListener('click', () => { state.logModal = null; render() })
  document.getElementById('log-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'log-modal-bg') { state.logModal = null; render() } })
  document.getElementById('lm-save')?.addEventListener('click', async () => {
    const portion = document.getElementById('lm-portion')?.value?.trim()
    const cals = parseInt(document.getElementById('lm-cals')?.value) || 0
    if (!portion) return
    const food = `${state.logModal.recipeName} (${portion})`
    const saved = await db.addLogEntry(food, cals)
    if (saved) state.log.push(saved)
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
}

// ── START ─────────────────────────────────────────────────────────────────────
init()
