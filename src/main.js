import * as db from './db.js'
import { getUserId } from './supabase.js'

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tab: localStorage.getItem('mep_tab') || 'recipes',
  recipes: [], pantry: [], shopList: [], log: [], exerciseLog: [], weightLog: [], historyExerciseLog: [],
  goals: { calories: 2000, goal: 'maintain' },
  loading: true,
  showGoals: false,
  showSync: false,
  showArchived: false,
  recipeView: 'list',    // 'cards' or 'list'
  recipeSort: 'newest',  // 'newest', 'az', 'za'
  cookMode: null,  // { recipeId, tab: 'ingredients'|'instructions' }
  chartWindow: '1M',  // '1W', '2W', '1M', '3M', 'All'
  expandedRecipe: null,
  calendarRecipePreview: null, // recipe id to show in modal from week tab
  activeCategory: 'All',
  allTags: [],
  activeTagFilters: {},   // keyed by namespace, null=default/show all, Set=explicit selection
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
  scanPickerOpen: false,
  logSearch: '',        // search query in log tab
  logTagFilter: null,
  logSearchFocused: false,
  logBreakdownId: null,
  chatRecipeContext: null,
  recipeChatMessages: {},   // keyed by recipe id, persistent per-recipe chat threads
  editingLogId: null,
  scaleModal: null,
  estimatingPrepId: null,
  refreshingPrepId: null,
  logDayOffset: 0,
  viewedDayLog: null,       // null = use today's state.log
  viewedDayExercise: null,  // null = use today's state.exerciseLog
  recipeSearch: '',
  pantrySearch: '',
  shopSearch: '',
  tagSearch: '',
  logRecipeResults: [], // recipe search results in log
  editingNotes: null,
  editingRecipeId: null,
  shopReview: null,
  _shopPendingItem: null,
  _shopPantryWarning: null,
  pasteModal: false,
  pasteModalDraft: { name: '', text: '', ingredients: '', instructions: '' }, // persists across re-renders
  addRecipeModal: false,
  addRecipeModalDraft: { name: '', ingredients: '', instructions: '', notes: '', tags: [] },
  logModal: null,
  gamePlanModal: false,
  gamePlanResult: null,
  gamePlanLoading: false,
  gamePlanView: 'timeline',
  gamePlanChats: {},
  timerSlider: null,  // { low, high, current, label }
}

const GOAL_PRESETS = {
  lose:     { calories: 1600, label: 'Lose Weight' },
  maintain: { calories: 2000, label: 'Maintain' },
  gain:     { calories: 2500, label: 'Build Muscle' },
}

// ── SHOP LIST HELPERS ─────────────────────────────────────────────────────────

// Extract the sortable ingredient name — strips leading qty, fractions, units
function shopSortKey(itemName) {
  return itemName
    // strip leading vulgar fractions
    .replace(/^[½⅓⅔¼¾⅛⅜⅝⅞\s]+/, '')
    // strip leading numbers like "2", "1/2", "1.5"
    .replace(/^\d+(?:[./]\d+)?\s*/, '')
    // strip leading unit words
    .replace(/^(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|grams?|kg|ml|liters?|pints?|quarts?|cans?|jars?|packages?|pkgs?|bunches?|heads?|cloves?|slices?|pieces?|large|medium|small|fresh|dried)\s+/i, '')
    .trim()
    .toLowerCase()
}

function sortShopList(items) {
  return [...items].sort((a, b) => shopSortKey(a.name).localeCompare(shopSortKey(b.name)))
}

// Purge shop items that were checked more than 1 hour ago
function purgeStaleCheckedItems() {
  const ONE_HOUR = 60 * 60 * 1000
  const now = Date.now()
  state.shopList = state.shopList.filter(i => {
    if (!i.have) return true
    if (!i.checked_at) return false // have=true but no timestamp — treat as purgeable
    return (now - i.checked_at) < ONE_HOUR
  })
}

// ── INIT ──────────────────────────────────────────────────────────────────────


async function sendChatMessage(userMessage) {
  if (!userMessage.trim() || state.chatLoading) return

  // Route to the right message thread
  const rid = state.chatRecipeContext?.id
  const getMessages = () => rid ? (state.recipeChatMessages[rid] || []) : state.chatMessages
  const pushMessage = (msg) => {
    if (rid) {
      if (!state.recipeChatMessages[rid]) state.recipeChatMessages[rid] = []
      state.recipeChatMessages[rid].push(msg)
    } else {
      state.chatMessages.push(msg)
    }
  }

  pushMessage({ role: 'user', content: userMessage })
  state.chatLoading = true
  render()

  setTimeout(() => {
    const el = document.getElementById('chat-messages')
    if (el) el.scrollTop = el.scrollHeight
  }, 50)

  try {
    const context = buildClaudeContext()
    const agentCtx = buildAgentContext(state.agentProfile)
    const recipeCtx = state.chatRecipeContext
      ? '\n\nFOCUS RECIPE — The user is asking specifically about this recipe:\nName: ' + state.chatRecipeContext.name +
        '\nIngredients:\n' + (state.chatRecipeContext.ingredients || '') +
        '\nInstructions:\n' + (state.chatRecipeContext.instructions || '') +
        '\n\nAnswer questions about this recipe specifically. Reference the actual ingredients and steps.'
      : ''
    const systemPrompt = 'You are a personal food and meal planning coach for this user. You know their recipes, pantry, eating habits and goals intimately. Be warm, specific, and actionable. Reference their actual recipes and patterns by name when relevant. Keep responses concise and practical.\n\nWhen asked to build a grocery list: look at THIS WEEK\'S MEAL PLAN to see what recipes are planned, then check each recipe\'s ingredients against the PANTRY (skip anything already there) and CURRENT SHOPPING LIST (skip anything already on it), and suggest only what\'s missing. List items grouped by recipe.\n\n' + context + agentCtx + recipeCtx
    const messages = getMessages().map(m => ({ role: m.role, content: m.content }))

    let resp, attempts = 0
    while (attempts < 3) {
      try {
        resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, system: systemPrompt })
        })
        if (resp.ok) break
        if (resp.status === 429 || resp.status === 529) {
          await new Promise(r => setTimeout(r, 2000 * (attempts + 1)))
          attempts++
          continue
        }
        throw new Error('API error ' + resp.status)
      } catch(e) {
        if (attempts >= 2) throw e
        await new Promise(r => setTimeout(r, 1500 * (attempts + 1)))
        attempts++
      }
    }
    if (!resp || !resp.ok) throw new Error('API error after retries')
    const data = await resp.json()
    const reply = data.content?.[0]?.text || 'Sorry, I could not get a response.'
    pushMessage({ role: 'assistant', content: reply })
  } catch(e) {
    pushMessage({ role: 'assistant', content: '[!] ' + (e.message || 'Something went wrong. Please try again.') })
  }

  state.chatLoading = false
  render()

  // Auto-save recipe chat to Supabase if in recipe context
  if (rid) {
    db.saveRecipeChat(rid, state.recipeChatMessages[rid] || [])
  }

  setTimeout(() => {
    const el = document.getElementById('chat-messages')
    if (el) el.scrollTop = el.scrollHeight
  }, 50)
}

function preserveRecipeEditState() {
  // If we're editing a recipe, snapshot current textarea values into state
  // so render() doesn't lose what the user typed when tags are added/removed
  if (state.editingRecipeId) {
    const rid = state.editingRecipeId
    const recipe = state.recipes.find(r => String(r.id) === String(rid))
    if (recipe) {
      const nameEl = document.getElementById('edit-recipe-name-' + rid)
      const ingEl = document.getElementById('edit-ingredients-' + rid)
      const instEl = document.getElementById('edit-instructions-' + rid)
      if (nameEl) recipe.name = nameEl.value
      if (ingEl) recipe.ingredients = ingEl.value
      if (instEl) recipe.instructions = instEl.value
    }
  }
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
  preserveRecipeEditState()
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
  preserveRecipeEditState()
  render()
}

async function init() {
  render()
  const weekDates = getWeekDates(0)
  const [recipes, pantry, shopList, log, goals, allTags, mealPlan, historyLog, exerciseLog, weightLog, gamePlans, historyExerciseLog] = await Promise.all([
    db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals(), db.fetchTags(),
    db.fetchMealPlan(weekDates[0], weekDates[6]), db.fetchFullLog(90), db.fetchExerciseLog(), db.fetchWeightLog(),
    db.fetchGamePlans(), db.fetchFullExerciseLog(30)
  ])
  state.allTags = allTags || []
  state.mealPlan = mealPlan || []
  state.historyLog = historyLog || []
  state.exerciseLog = exerciseLog || []
  state.historyExerciseLog = historyExerciseLog || []
  state.agentProfile = buildAgentProfile(state.historyLog, [])
  state.recipes  = recipes.map(normalizeRecipe)
  state.pantry   = pantry
  state.shopList = shopList.map(i => ({ ...i, fromRecipe: i.from_recipe }))
  state.log      = log
  if (goals) state.goals = {
    calories: goals.calories || 2000,
    goal: goals.goal_type || 'maintain',
    protein: goals.protein || 150,
    carbs: goals.carbs || 200,
    fat: goals.fat || 65,
    weight: goals.weight || '',
    age: goals.age || '',
    height_inches: goals.height_inches || '',
    activity_level: goals.activity_level || 'moderate',
    target_weight: goals.target_weight || '',
    loss_pace: goals.loss_pace || 'moderate',
    goal_start_date: goals.goal_start_date || null
  }
  state.loading  = false

  state.loading  = false

  // Hydrate game plan chats and timelines from Supabase
  if (gamePlans && gamePlans.length > 0) {
    gamePlans.forEach(gp => {
      const key = gp.date + '-' + gp.slot
      if (gp.chat_messages && gp.chat_messages.length > 0) {
        state.gamePlanChats[key] = gp.chat_messages
      }
      if (!state._lastGamePlan || new Date(gp.updated_at) > new Date(state._lastGamePlan._updated || 0)) {
        state._lastGamePlan = { slot: gp.slot, date: gp.date, targetTime: gp.target_time, _updated: gp.updated_at }
        if (gp.timeline) state.gamePlanResult = gp.timeline
      }
    })
  }

  // Refresh historical data fresh on every load to catch yesterday's entries
  const [freshHistoryLog, freshWeightLog, freshHistoryExercise] = await Promise.all([
    db.fetchFullLog(90),
    db.fetchWeightLog(),
    db.fetchFullExerciseLog(30)
  ])
  state.historyLog = freshHistoryLog || []
  state.weightLog = freshWeightLog || []
  state.historyExerciseLog = freshHistoryExercise || []
  state._weekDataLoaded = false
  state._weekByDate = {}
  state._weekExByDate = {}

  // Purge shop items checked more than 1 hour ago
  purgeStaleCheckedItems()

  render()
}

function normalizeRecipe(r) {
  return { ...r, cookingNotes: r.cooking_notes || '', clippedFrom: r.clipped_from || '', category: r.category || '', tags: r.tags || [], text: [r.ingredients, r.instructions].filter(Boolean).join('\n\n'), prepTime: r.prep_time || null }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function calcTDEE(weight_lbs, height_inches, age, activity_level) {
  if (!weight_lbs || !height_inches || !age) return null
  // Mifflin-St Jeor (male default — we can add sex later)
  const weight_kg = weight_lbs * 0.453592
  const height_cm = height_inches * 2.54
  const bmr = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) + 5
  const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }
  return Math.round(bmr * (multipliers[activity_level] || 1.55))
}

function calcProjection(tdee, current_weight, target_weight, daily_calories) {
  if (!tdee || !current_weight || !target_weight || !daily_calories) return null
  const daily_deficit = tdee - daily_calories
  if (daily_deficit <= 0) return null
  const lbs_to_lose = current_weight - target_weight
  if (lbs_to_lose <= 0) return null
  const days_needed = Math.round((lbs_to_lose * 3500) / daily_deficit)
  const target_date = new Date()
  target_date.setDate(target_date.getDate() + days_needed)
  return {
    days: days_needed,
    weeks: Math.round(days_needed / 7),
    date: target_date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    lbs_per_week: Math.round((daily_deficit * 7 / 3500) * 10) / 10
  }
}

function buildGoalsSuggestions() {
  const { weight, age, height_inches, activity_level, target_weight } = state.goals
  const tdee = calcTDEE(weight, height_inches, age, activity_level)
  if (!tdee || !target_weight || target_weight >= weight) return null
  const moderate = calcProjection(tdee, weight, target_weight, tdee - 500)
  const faster = calcProjection(tdee, weight, target_weight, tdee - 750)
  return { tdee, moderate: { calories: tdee - 500, ...moderate }, faster: { calories: tdee - 750, ...faster } }
}

function todayCalories() { return state.log.reduce((s,e) => s + (e.calories||0), 0) }
function todayBurned() { return (state.exerciseLog || []).reduce((s,e) => s + (e.calories_burned||0), 0) }


// Strip measurements from ingredient lines for pantry matching
function stripMeasurements(line) {
  return line.toLowerCase()
    .replace(/[\d¼½¾⅓⅔⅛⅜⅝⅞]+\/?\ d*\s*/g, '')
    .replace(/\b(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|grams?|kg|ml|liters?|pints?|quarts?|cans?|jars?|packages?|bunches?|heads?|cloves?|slices?|pieces?|large|medium|small|fresh|dried|chopped|minced|diced|sliced|about|to\s+\d+)\b/gi, '')
    .replace(/[,.\-–()]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Parse ingredient line to clean shopping list format
function parseIngredientLine(line) {
  let s = line.trim()

  // Remove parenthetical notes
  s = s.replace(/\([^)]*\)/g, ' ')
  // Remove everything after comma, semicolon, or em-dash
  s = s.replace(/[,;–—].*$/, '')
  s = s.replace(/\s+/g, ' ').trim()

  // Handle vulgar fractions at start
  s = s.replace(/^([¼½¾⅓⅔⅛⅜⅝⅞])\s*/, (_, frac) => {
    const map = {'¼':'1/4','½':'1/2','¾':'3/4','⅓':'1/3','⅔':'2/3','⅛':'1/8','⅜':'3/8','⅝':'5/8','⅞':'7/8'}
    return (map[frac] || frac) + ' '
  })
  // Also handle mixed numbers like "1½" -> "1.5"
  s = s.replace(/(\d+)[¼½¾⅓⅔⅛⅜⅝⅞]/, m => m[0])

  const unitMap = {
    'tablespoons?': 'tbsp', 'tbsp': 'tbsp', 'teaspoons?': 'tsp', 'tsp': 'tsp',
    'cups?': 'cup', 'ounces?': 'oz', 'oz': 'oz', 'pounds?': 'lb', 'lbs?': 'lb',
    'grams?': 'g', 'kg': 'kg', 'ml': 'ml', 'liters?': 'L',
    'cans?': 'can', 'jars?': 'jar', 'packages?': 'pkg', 'bunches?': 'bunch',
    'heads?': 'head', 'cloves?': 'clove', 'slices?': 'slice', 'pieces?': 'piece',
    'sprigs?': 'sprig', 'stalks?': 'stalk', 'strips?': 'strip'
  }
  const unitPattern = Object.keys(unitMap).join('|')
  const qtyRe = new RegExp('^(\\d+(?:[\\./]\\d+)?(?:\\s+\\d+\\/\\d+)?)\\s*(?:(' + unitPattern + ')\\s+)?', 'i')

  // Extract quantity + unit
  let qty = ''
  const m = s.match(qtyRe)
  if (m) {
    const num = m[1].trim()
    const rawUnit = m[2]
    const unit = rawUnit
      ? (unitMap[Object.keys(unitMap).find(k => new RegExp('^' + k + '$', 'i').test(rawUnit))] || rawUnit.toLowerCase())
      : ''
    qty = unit ? num + ' ' + unit : num
    s = s.slice(m[0].length).trim()
  }

  // Strip leading prep/descriptor words — but only from the start, not mid-name
  s = s.replace(/^(chopped|sliced|diced|minced|grated|shredded|peeled|trimmed|divided|softened|melted|beaten|packed|heaping|frozen|raw|cooked|whole|boneless|skinless|canned|unsalted|salted|dried|ground|crumbled|cracked|toasted)\s+/gi, '')

  // Strip trailing prep notes
  s = s.replace(/\s*,?\s*(chopped|sliced|diced|minced|grated|shredded|peeled|trimmed|divided|softened|melted|beaten|room temperature|at room temp|packed|heaping|to taste|or more|such as|for serving|for garnish|optional).*$/gi, '')
  s = s.replace(/\s+/g, ' ').trim()

  // If we ended up with nothing or just a number, return the original line cleaned up
  if (!s || /^\d+$/.test(s)) {
    // Fall back: just return the line with leading qty stripped but everything else intact
    s = line.replace(/\([^)]*\)/g, '').replace(/^[\d¼½¾⅓⅔⅛⅜⅝⅞\/\s]+(?:tablespoons?|tbsp|teaspoons?|tsp|cups?|ounces?|oz|pounds?|lbs?|grams?|g|kg|ml|cans?|jars?|packages?|bunches?|heads?|cloves?|slices?)\s*/gi, '').replace(/[,;].*$/, '').replace(/\s+/g, ' ').trim()
  }

  const name = s.charAt(0).toUpperCase() + s.slice(1)
  return qty ? name + ', ' + qty : name
}

function buildClaudeContext() {
  const recipeList = state.recipes.length === 0 ? "No recipes saved yet."
    : state.recipes.filter(r => !r.archived).map((r,i) => (i+1) + ". " + r.name + "\nIngredients:\n" + (r.ingredients||"") + (r.cookingNotes ? "\nNotes: " + r.cookingNotes : "")).join("\n\n")
  const pantryList = state.pantry.length === 0 ? "Empty."
    : state.pantry.map(p => p.name + (p.qty ? " (" + p.qty + ")" : "")).join(", ")
  const shopList = state.shopList.filter(i => !i.have).length === 0 ? "Empty."
    : state.shopList.filter(i => !i.have).map(i => i.name).join(", ")
  const logList = state.log.length === 0 ? "Nothing logged." : state.log.map(e => "- " + e.food + ": " + e.calories + " cal").join("\n")
  const exerciseList = (state.exerciseLog || []).length === 0 ? "None." : state.exerciseLog.map(e => "- " + e.activity + ": " + e.calories_burned + " cal burned").join("\n")
  const netCals = todayCalories() - todayBurned()

  // Meal plan for this week
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0,0,0,0)
  const weekDates = Array.from({length: 7}, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i)
    return d.toISOString().slice(0,10)
  })
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
  let mealPlanText = "No meals planned this week."
  if (state.mealPlan && state.mealPlan.length > 0) {
    const weekEntries = state.mealPlan.filter(e => weekDates.includes(e.date))
    if (weekEntries.length > 0) {
      const byDay = {}
      weekEntries.forEach(e => {
        if (!byDay[e.date]) byDay[e.date] = []
        byDay[e.date].push(e.meal_slot + ": " + e.recipe_name)
      })
      mealPlanText = weekDates.map((d, i) => {
        const entries = byDay[d]
        return entries ? dayNames[i] + " " + d + "\n" + entries.map(e => "  - " + e).join("\n") : null
      }).filter(Boolean).join("\n")
    }
  }

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
    "GOALS: " + state.goals.calories + " cal/day | Protein " + state.goals.protein + "g | Carbs " + state.goals.carbs + "g | Fat " + state.goals.fat + "g | Goal: " + goalLabel +
    (state.goals.weight ? " | Weight: " + state.goals.weight + " lbs" : "") +
    (state.goals.age ? " | Age: " + state.goals.age : "") + "\n\n" +
    "TODAY'S LOG:\n" + logList + "\nTotal in: " + todayCalories() + " cal\n\n" +
    "TODAY'S EXERCISE:\n" + exerciseList + "\nTotal burned: " + todayBurned() + " cal\nNet calories: " + netCals + " / " + state.goals.calories + " goal\n\n" +
    "THIS WEEK'S MEAL PLAN:\n" + mealPlanText + "\n\n" +
    "CURRENT SHOPPING LIST: " + shopList + "\n\n" +
    "PANTRY: " + pantryList + "\n\n" +
    "EATING HISTORY (last 90 days):\n" + historySummary + "\n\n" +
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
    const trimmed = line.trim()
    if (!trimmed) return '<div style="height:8px"></div>'
    const withTimers = linkifyTimers(esc(trimmed))
    if (trimmed.startsWith('•') || /^\d+\./.test(trimmed)) return `<div class="rt-item">${withTimers}</div>`
    return `<div class="rt-line">${withTimers}</div>`
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

// ── TIMER SYSTEM ─────────────────────────────────────────────────────────────

const timers = [] // array of { id, label, totalSeconds, remaining, interval }
let timerIdCounter = 0
let globalWakeLock = null

// ── AUDIO BEEP VIA HTML AUDIO ELEMENT (more reliable on iOS) ─────────────────
// Short beep encoded as a base64 WAV data URI
const BEEP_WAV = 'data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAB4AHgAeAB4AHgA' +
  'eAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AHgAeAB4AA=='

let beepAudio = null

function unlockAudio() {
  // Create and pre-load audio element on user gesture tap — required for iOS
  if (!beepAudio) {
    beepAudio = new Audio()
    beepAudio.src = generateBeepDataURI()
    beepAudio.load()
  }
  // Play and immediately pause to "unlock" on iOS
  const p = beepAudio.play()
  if (p) p.catch(() => {})
  setTimeout(() => { if (beepAudio) beepAudio.pause(); beepAudio && (beepAudio.currentTime = 0) }, 50)
}

function generateBeepDataURI() {
  const sampleRate = 44100
  const duration = 0.3
  const freq = 740  // slightly lower than 880 — carries better
  const numSamples = Math.floor(sampleRate * duration)
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)

  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, numSamples * 2, true)

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const fade = i < sampleRate * 0.01 ? (i / (sampleRate * 0.01)) : 1 - ((i - sampleRate * 0.01) / (numSamples - sampleRate * 0.01))
    const sample = Math.sin(2 * Math.PI * freq * t) * fade * 0.99  // max amplitude
    view.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, sample * 32767)), true)
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return 'data:audio/wav;base64,' + btoa(binary)
}

function timerBeep() {
  try {
    if (!beepAudio) {
      beepAudio = new Audio(generateBeepDataURI())
      beepAudio.load()
    }
    beepAudio.volume = 1.0
    beepAudio.currentTime = 0
    const p = beepAudio.play()
    if (p) p.catch(e => console.error('beep play error', e))
  } catch(e) { console.error('beep error', e) }

  // Vibrate if supported — three pulses
  try {
    if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400])
  } catch(e) {}
}

let keepAliveInterval = null
function startAudioKeepAlive() {}
function stopAudioKeepAlive() {}

async function requestWakeLock() {
  if (globalWakeLock) return
  try {
    if (navigator.wakeLock) globalWakeLock = await navigator.wakeLock.request('screen')
  } catch(e) {}
}

function releaseWakeLockIfDone() {
  if (timers.every(t => t.remaining <= 0)) {
    if (globalWakeLock) { globalWakeLock.release(); globalWakeLock = null }
  }
}

async function startTimer(seconds, label) {
  const id = ++timerIdCounter
  const timer = { id, label, totalSeconds: seconds, remaining: seconds, interval: null, beepInterval: null }

  timer.interval = setInterval(() => {
    timer.remaining--
    if (timer.remaining <= 0) {
      timer.remaining = 0
      clearInterval(timer.interval)
      timer.interval = null
      timerBeep()
      timer.beepInterval = setInterval(() => timerBeep(), 1500)
      releaseWakeLockIfDone()
    }
    renderTimerBar()
  }, 1000)

  timers.push(timer)
  await requestWakeLock()
  startAudioKeepAlive()
  renderTimerBar()
}

function stopTimer(id) {
  const idx = timers.findIndex(t => t.id === id)
  if (idx === -1) return
  const timer = timers[idx]
  if (timer.interval) clearInterval(timer.interval)
  if (timer.beepInterval) clearInterval(timer.beepInterval)
  timers.splice(idx, 1)
  releaseWakeLockIfDone()
  if (timers.length === 0) stopAudioKeepAlive()
  renderTimerBar()
}

function renderTimerBar() {
  // Preserve position if already dragged
  const existing = document.getElementById('timer-bar')
  const savedPos = existing ? { left: existing.style.left, top: existing.style.top, right: existing.style.right, bottom: existing.style.bottom } : null
  existing?.remove()
  if (timers.length === 0) return

  const rows = timers.map(timer => {
    const mins = Math.floor(timer.remaining / 60)
    const secs = timer.remaining % 60
    const timeStr = mins + ':' + String(secs).padStart(2, '0')
    const pct = timer.totalSeconds > 0 ? (timer.remaining / timer.totalSeconds) * 100 : 0
    const isDone = timer.remaining === 0
    const barColor = isDone ? '#e05a2b' : pct < 20 ? '#e09b2b' : 'var(--accent)'
    return '<div style="padding:8px 0;border-bottom:1px solid var(--cream2)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--text-3);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(timer.label) + '</div>' +
        '<button class="timer-stop-btn" data-timer-id="' + timer.id + '" style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--text-3);padding:0;line-height:1">×</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<div style="font-size:22px;font-weight:800;color:' + barColor + ';font-variant-numeric:tabular-nums;min-width:55px">' + (isDone ? '✓ Done!' : timeStr) + '</div>' +
        '<div style="flex:1;height:4px;background:var(--gray-200);border-radius:2px">' +
          '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:2px;transition:width 1s linear"></div>' +
        '</div>' +
      '</div>' +
    '</div>'
  }).join('')

  const html = '<div id="timer-bar" style="position:fixed;bottom:70px;right:18px;z-index:1000;background:white;border:2px solid var(--forest2);border-radius:14px;padding:4px 14px;box-shadow:0 4px 16px rgba(0,0,0,0.18);min-width:200px;max-width:240px;font-family:inherit;touch-action:none;user-select:none">' +
    '<div id="timer-drag-handle" style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;padding:6px 0 2px;cursor:grab;display:flex;align-items:center;justify-content:space-between">⏱ Timers <span style="color:var(--text-4);letter-spacing:2px">⠿</span></div>' +
    rows +
  '</div>'

  document.body.insertAdjacentHTML('beforeend', html)
  const bar = document.getElementById('timer-bar')

  // Restore saved position if dragged previously
  if (savedPos && savedPos.left) {
    bar.style.right = 'auto'; bar.style.bottom = 'auto'
    bar.style.left = savedPos.left; bar.style.top = savedPos.top
  }

  // Drag logic
  let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0
  const onStart = (e) => {
    if (e.target.closest('.timer-stop-btn')) return
    dragging = true
    const t = e.touches ? e.touches[0] : e
    startX = t.clientX; startY = t.clientY
    const rect = bar.getBoundingClientRect()
    origLeft = rect.left; origTop = rect.top
    bar.style.right = 'auto'; bar.style.bottom = 'auto'
    bar.style.left = origLeft + 'px'; bar.style.top = origTop + 'px'
    bar.style.cursor = 'grabbing'
    e.preventDefault()
  }
  const onMove = (e) => {
    if (!dragging) return
    const t = e.touches ? e.touches[0] : e
    const newLeft = Math.max(0, Math.min(window.innerWidth - bar.offsetWidth, origLeft + t.clientX - startX))
    const newTop = Math.max(0, Math.min(window.innerHeight - bar.offsetHeight, origTop + t.clientY - startY))
    bar.style.left = newLeft + 'px'; bar.style.top = newTop + 'px'
    e.preventDefault()
  }
  const onEnd = () => { dragging = false; bar.style.cursor = 'default' }

  const handle = document.getElementById('timer-drag-handle')
  handle.addEventListener('mousedown', onStart)
  handle.addEventListener('touchstart', onStart, { passive: false })
  document.addEventListener('mousemove', onMove)
  document.addEventListener('touchmove', onMove, { passive: false })
  document.addEventListener('mouseup', onEnd)
  document.addEventListener('touchend', onEnd)

  document.querySelectorAll('.timer-stop-btn').forEach(btn => {
    btn.addEventListener('click', () => stopTimer(parseInt(btn.dataset.timerId)))
  })
}

// Parse a time string like "9 min", "12 minutes", "9-12 min", "5 to 10 min", "1 hour 30 min" into seconds
// Returns { seconds, label } or null
function parseTimerDuration(text) {
  text = text.toLowerCase().trim()
  const toSecs = (n, unit) => {
    if (!unit) return parseInt(n) * 60
    if (unit.startsWith('hour') || unit === 'hr' || unit === 'h') return parseInt(n) * 3600
    if (unit.startsWith('sec')) return parseInt(n)
    return parseInt(n) * 60
  }
  // Range with "to" — return both bounds
  const toMatch = text.match(/(\d+)\s+to\s+(\d+)\s*(min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)?/)
  if (toMatch) return { low: toSecs(toMatch[1], toMatch[3]), high: toSecs(toMatch[2], toMatch[3]), isRange: true, label: text }
  // Range with dash — REQUIRE a time unit so '100-120 ml' doesn't match
  const dashMatch = text.match(/(\d+)\s*[-–]\s*(\d+)\s*(min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)/)
  if (dashMatch) return { low: toSecs(dashMatch[1], dashMatch[3]), high: toSecs(dashMatch[2], dashMatch[3]), isRange: true, label: text }
  // Hours + minutes
  const hourMin = text.match(/(\d+)\s*(?:hour|hr|h)\s*(?:(\d+)\s*(?:min|minute|minutes|mins))?/)
  if (hourMin) return { seconds: parseInt(hourMin[1]) * 3600 + parseInt(hourMin[2] || 0) * 60, label: text }
  // Just minutes
  const min = text.match(/(\d+)\s*(?:min|minute|minutes|mins)/)
  if (min) return { seconds: parseInt(min[1]) * 60, label: text }
  // Just seconds
  const sec = text.match(/(\d+)\s*(?:sec|second|seconds|secs)/)
  if (sec) return { seconds: parseInt(sec[1]), label: text }
  return null
}

// Linkify time references — ranges get a slider button, single times get a direct start button
function linkifyTimers(html) {
  return html.replace(/(\d+\s+to\s+\d+\s*(?:min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)?|\d+\s*[-–]\s*\d+\s*(?:min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)|\d+\s*(?:hour|hr|h)(?:\s+\d+\s*(?:min|minute|minutes|mins))?|\d+\s*(?:min|minute|minutes|mins|sec|second|seconds|secs))/gi, (match) => {
    const parsed = parseTimerDuration(match)
    if (!parsed) return match
    if (parsed.isRange) {
      // Range — show slider button
      return '<button class="timer-link timer-range-link" data-timer-low="' + parsed.low + '" data-timer-high="' + parsed.high + '" data-timer-label="' + esc(match.trim()) + '" style="background:var(--accent-light);border:1px solid var(--accent-mid);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:inherit;font-family:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:3px">⏱ ' + match.trim() + '</button>'
    }
    return '<button class="timer-link" data-timer-seconds="' + parsed.seconds + '" data-timer-label="' + esc(match.trim()) + '" style="background:var(--accent-light);border:1px solid var(--accent-mid);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:inherit;font-family:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:3px">⏱ ' + match.trim() + '</button>'
  })
}

// ── STEP AMOUNTS ──────────────────────────────────────────────────────────────
async function fetchStepAmounts(recipeId) {
  const r = state.recipes.find(x => x.id === recipeId)
  if (!r || !r.ingredients || !r.instructions) return
  if (!state.cookMode || state.cookMode.recipeId !== recipeId) return
  if (state.cookMode.stepAmounts || state.cookMode.stepAmountsLoading) return
  state.cookMode = { ...state.cookMode, stepAmountsLoading: true }
  render()
  try {
    const prompt = 'Given this ingredient list and recipe instructions, for each numbered step list which ingredients (with exact amounts) are used in that step. Return ONLY valid JSON with no extra text: {"steps":[{"step":1,"amounts":["2 tbsp butter","1 cup cream"]},{"step":2,"amounts":["1 tsp salt"]}]}. Only include steps that use ingredients with measurable amounts. Do not include steps with no ingredients.\n\nIngredients:\n' + r.ingredients + '\n\nInstructions:\n' + r.instructions
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: 'You map recipe ingredients to steps. Return only valid JSON, no explanation.',
        messages: [{ role: 'user', content: prompt }]
      })
    })
    const data = await res.json()
    const text = (data.content || []).find(b => b.type === 'text')?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    const map = {}
    ;(parsed.steps || []).forEach(s => { map[s.step] = s.amounts || [] })
    if (state.cookMode && state.cookMode.recipeId === recipeId) {
      state.cookMode = { ...state.cookMode, stepAmounts: map, stepAmountsLoading: false }
      render()
    }
  } catch(e) {
    console.warn('fetchStepAmounts error:', e)
    if (state.cookMode && state.cookMode.recipeId === recipeId) {
      state.cookMode = { ...state.cookMode, stepAmountsLoading: false }
      render()
    }
  }
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
        <div class="header-title">Mise En Place</div>
        <div class="header-right">
          ${cals > 0 ? '<div class="header-cal">Today: ' + cals + ' cal</div>' : ''}
        </div>
      </div>



      <!-- GOALS PANEL -->
      ${state.showGoals ? `
      <div class="goals-panel">
        <div class="goals-title">Your Goals</div>

        <!-- Row 1: Start date + Start weight -->
        <div class="goals-grid">
          <div class="goal-field">
            <label>Goal Start Date</label>
            <input type="date" id="goal-start-date-input" style="padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;font-size:13px;width:100%" value="${state.goals.goal_start_date || new Date().toISOString().slice(0,10)}" />
          </div>
          <div class="goal-field">
            <label>Goal Start Weight (lbs)</label>
            <input type="number" data-goal="weight" value="${state.goals.weight||''}" placeholder="e.g. 186" />
          </div>
        </div>

        <!-- Row 2: Target weight + Current weight (read-only) -->
        <div class="goals-grid" style="margin-top:8px">
          <div class="goal-field">
            <label>Target Weight (lbs)</label>
            <input type="number" data-goal="target_weight" value="${state.goals.target_weight||''}" placeholder="e.g. 165" />
          </div>
          <div class="goal-field">
            <label>Current Weight (lbs)</label>
            <div style="padding:8px;background:rgba(255,255,255,0.08);border-radius:8px;border:1px solid rgba(255,255,255,0.15);font-size:13px;color:${state.weightLog&&state.weightLog.length>0?'white':'rgba(255,255,255,0.35)'}">
              ${state.weightLog&&state.weightLog.length>0 ? state.weightLog[state.weightLog.length-1].weight+' lbs' : 'Log a weigh-in'}
            </div>
          </div>
        </div>

        <!-- Row 3: Height + Age -->
        <div class="goals-grid" style="margin-top:8px">
          <div class="goal-field">
            <label>Height (inches)</label>
            <input type="number" data-goal="height_inches" value="${state.goals.height_inches||''}" placeholder="e.g. 70" />
          </div>
          <div class="goal-field">
            <label>Age</label>
            <input type="number" data-goal="age" value="${state.goals.age||''}" placeholder="e.g. 35" />
          </div>
        </div>

        <!-- Activity level -->
        <div class="goal-field" style="margin-top:8px">
          <label>Activity Level</label>
          <select data-goal="activity_level" style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:var(--black);color:white;font-size:13px">
            <option value="sedentary" ${state.goals.activity_level==='sedentary'?'selected':''}>Sedentary (desk job, little exercise)</option>
            <option value="light" ${state.goals.activity_level==='light'?'selected':''}>Lightly Active (1-3 days/week)</option>
            <option value="moderate" ${state.goals.activity_level==='moderate'?'selected':''}>Moderately Active (3-5 days/week)</option>
            <option value="active" ${state.goals.activity_level==='active'?'selected':''}>Very Active (6-7 days/week)</option>
            <option value="very_active" ${state.goals.activity_level==='very_active'?'selected':''}>Extremely Active (physical job + exercise)</option>
          </select>
        </div>

        <!-- Pace cards -->
        ${(() => {
          const s = buildGoalsSuggestions()
          if (!s) return '<div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:10px">Fill in start weight, target weight, height, and age to see your calorie targets.</div>'
          return `
          <div style="margin-top:12px;font-size:11px;color:rgba(255,255,255,0.5)">Maintenance calories (TDEE): ~${s.tdee} cal/day</div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="goal-pace-card ${state.goals.loss_pace==='moderate'?'active':''}" data-pace="moderate" data-calories="${s.moderate.calories}">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span style="font-weight:700">Moderate</span>
                <span style="font-size:15px;font-weight:800">${s.moderate.calories} cal/day</span>
              </div>
              <div style="font-size:11px;opacity:0.8">~${s.moderate.lbs_per_week} lbs/week · Reach ${state.goals.target_weight} lbs by ${s.moderate.date}</div>
            </div>
            <div class="goal-pace-card ${state.goals.loss_pace==='faster'?'active':''}" data-pace="faster" data-calories="${s.faster.calories}">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span style="font-weight:700">Faster</span>
                <span style="font-size:15px;font-weight:800">${s.faster.calories} cal/day</span>
              </div>
              <div style="font-size:11px;opacity:0.8">~${s.faster.lbs_per_week} lbs/week · Reach ${state.goals.target_weight} lbs by ${s.faster.date}</div>
            </div>
          </div>
          <div style="margin-top:8px;font-size:11px;color:rgba(255,255,255,0.5)">Tap a plan to select it. Current goal: <strong style="color:white">${state.goals.calories} cal/day</strong></div>`
        })()}

        <button id="save-goals-btn" style="width:100%;margin-top:14px;padding:12px;background:white;color:var(--accent);border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">💾 Save Goals</button>

      </div>` : ''}
      <!-- TABS -->
      <div class="tabs">
        <div class="tab ${state.tab==='recipes'?'active':''}" data-tab="recipes">Recipes${state.recipes.length>0?'<span class="tab-badge">'+state.recipes.length+'</span>':''}</div>
        <div class="tab ${state.tab==='shop'?'active':''}" data-tab="shop">List${needCount>0?'<span class="tab-badge">'+needCount+'</span>':''}</div>
        <div class="tab ${state.tab==='calendar'?'active':''}" data-tab="calendar">Week</div>
        <div class="tab ${state.tab==='log'?'active':''}" data-tab="log">Log</div>
        <div class="tab" id="nav-update-btn">Update</div>
        <div class="tab" id="nav-sync-btn">Sync</div>
      </div>



      <!-- CONTENT -->
      <div class="content">
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
            <div style="font-size:11px;color:var(--text-3);line-height:1.5">Open this link in Safari, then Share → Add to Home Screen. Your Account ID saves automatically.</div>
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
        </div>` : ''}
        ${state.loading ? '<div class="loading"><div class="spinner"></div><div>Loading your data…</div></div>' : ''}
        ${!state.loading && state.tab === 'recipes' ? renderRecipes() : ''}
        ${!state.loading && state.tab === 'pantry'  ? renderPantry()  : ''}
        ${!state.loading && state.tab === 'shop'    ? renderShop()    : ''}
        ${!state.loading && state.tab === 'log'     ? renderLog()     : ''}
        ${!state.loading && state.tab === 'calendar' ? renderCalendar() : ''}
        ${!state.loading && state.tab === 'tags'    ? renderTags()    : ''}
        ${!state.loading && state.tab === 'chat'    ? renderChat()    : ''}
      </div>

      <!-- MODALS -->
      ${state.pasteModal    ? renderPasteModal()    : ''}
      ${state.clipUrlModal  ? renderClipUrlModal()  : ''}
      ${state.shopReview    ? renderShopReview()    : ''}
      ${state.addToWeekModal ? renderAddToWeekModal() : ''}
      ${state.scanPickerOpen ? renderScanPicker() : ''}
      ${state.logModal      ? renderLogModal()      : ''}
      
      ${state.tagOrganizerModal ? renderTagOrganizerModal() : ''}
      ${state.gamePlanModal  ? renderGamePlanModal() : ''}
      ${state.calendarRecipePreview ? renderCalendarRecipePreviewModal() : ''}

      <!-- SCROLL TO TOP -->
      <button id="scroll-top-btn" style="display:none;position:fixed;bottom:24px;right:18px;z-index:999;background:var(--black);color:white;border:none;border-radius:50px;padding:8px 14px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,0.25);align-items:center;gap:5px">&#8679; Top</button>
    </div>
  `
  bindEvents()

  // Timer slider popover
  if (state.timerSlider) {
    const { low, high, current, label } = state.timerSlider
    const mins = Math.round(current / 60)
    // Centered modal overlay — works consistently inside cook mode and main app
    const overlay = document.createElement('div')
    overlay.id = 'timer-slider-popover'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:24px'
    overlay.innerHTML =
      '<div style="background:white;border-radius:16px;padding:20px;width:100%;max-width:280px;font-family:inherit">' +
        '<div style="font-size:11px;font-weight:600;color:#888;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:12px">⏱ ' + esc(label) + '</div>' +
        '<div id="timer-mins-display" style="font-size:36px;font-weight:700;color:#1a1a1a;text-align:center;margin-bottom:12px;font-variant-numeric:tabular-nums">' + mins + ' min</div>' +
        '<input id="timer-range-slider" type="range" min="' + low + '" max="' + high + '" step="60" value="' + current + '" style="width:100%;accent-color:#3d52c4;margin-bottom:16px" />' +
        '<div style="display:flex;gap:8px">' +
          '<button id="timer-slider-start" style="flex:1;background:#1a1a1a;color:white;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Start timer</button>' +
          '<button id="timer-slider-cancel" style="background:none;border:1.5px solid #ddd;border-radius:10px;padding:12px 14px;font-size:14px;cursor:pointer;font-family:inherit;color:#888">✕</button>' +
        '</div>' +
      '</div>'
    document.body.appendChild(overlay)

    document.getElementById('timer-range-slider')?.addEventListener('input', e => {
      state.timerSlider.current = parseInt(e.target.value)
      const m = Math.round(state.timerSlider.current / 60)
      document.getElementById('timer-mins-display').textContent = m + ' min'
    })
    document.getElementById('timer-slider-start')?.addEventListener('click', () => {
      unlockAudio()
      startTimer(state.timerSlider.current, state.timerSlider.label)
      state.timerSlider = null
      overlay.remove()
    })
    document.getElementById('timer-slider-cancel')?.addEventListener('click', () => {
      state.timerSlider = null
      overlay.remove()
    })
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { state.timerSlider = null; overlay.remove() }
    })
  }

  // Re-render timer bar if any timers active (survives render cycles)
  if (timers.length > 0) renderTimerBar()

  // Scroll-to-top — body is the scroll container
  const scrollTopBtn = document.getElementById('scroll-top-btn')
  if (scrollTopBtn) {
    const onScroll = () => {
      scrollTopBtn.style.display = document.body.scrollTop > 300 ? 'flex' : 'none'
    }
    document.body.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    scrollTopBtn.addEventListener('click', () => document.body.scrollTo({ top: 0, behavior: 'smooth' }))
  }
  // Position active tag picker near its button
  const activePicker = document.getElementById('tag-picker-popover')
  if (activePicker && state.tagPickerPos) {
    activePicker.style.top = state.tagPickerPos.top + 'px'
    activePicker.style.left = Math.min(state.tagPickerPos.left, window.innerWidth - 220) + 'px'
    // Scroll into view if still off screen
    const rect = activePicker.getBoundingClientRect()
    if (rect.bottom > window.innerHeight) {
      activePicker.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
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
  const allTags = getTagsForNamespace(namespace).slice().sort((a, b) => a.name.localeCompare(b.name))
  if (!allTags.length) return ''
  const active = state.activeTagFilters[namespace]
  const isDefault = active === null || active === undefined
  const categories = allTags.filter(t => !t.tag_type || t.tag_type === 'category')
  const styles = allTags.filter(t => t.tag_type === 'style')
  const hasTwoTiers = styles.length > 0 && categories.length > 0
  const allSelected = !isDefault && allTags.every(t => active.has(t.name))

  const chipBtn = (t) => {
    const isActive = !isDefault && active.has(t.name)
    return '<button class="tag-filter-chip ' + (isActive ? 'active' : '') + '" data-filter-tag="' + esc(t.name) + '" data-filter-ns="' + namespace + '">' + esc(t.name) + '</button>'
  }

  const selectAllBtn = '<button class="tag-filter-chip ' + (allSelected ? 'active' : '') + '" data-filter-all="' + namespace + '" style="font-size:11px;font-weight:700">Select All</button>'

  if (!hasTwoTiers) {
    return '<div class="tag-filter-wrap">' +
      '<div class="tag-filter-row">' +
        allTags.map(chipBtn).join('') +
        '<button class="tag-filter-chip ' + (!isDefault && active.has('__untagged__') ? 'active' : '') + '" data-filter-tag="__untagged__" data-filter-ns="' + namespace + '">Untagged</button>' +
      '</div>' +
    '</div>'
  }

  return '<div class="tag-filter-wrap">' +
    '<div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Category</div>' +
    '<div class="tag-filter-row" style="margin-bottom:8px">' + categories.map(chipBtn).join('') + '</div>' +
    '<div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Style</div>' +
    '<div class="tag-filter-row">' +
      styles.map(chipBtn).join('') +
      '<button class="tag-filter-chip ' + (!isDefault && active.has('__untagged__') ? 'active' : '') + '" data-filter-tag="__untagged__" data-filter-ns="' + namespace + '">Untagged</button>' +
    '</div>' +
  '</div>'
}


function renderRecipeCard(r) {
  const isExpanded = state.expandedRecipe === r.id
  const pt = r.prepTime

  // ── COLLAPSED: name + tags + prep time summary only ──
  const prepSummary = pt
    ? '<div class="recipe-prep-summary">⏱ ' + pt.active_min + ' min' +
        (pt.passive_min > 0 ? ' + ' + pt.passive_min + ' min passive' : '') +
        ' · ' + (pt.difficulty || '') +
        (pt.make_ahead && pt.make_ahead !== 'none' && pt.make_ahead !== 'None' ? ' · Make-ahead ✓' : '') +
      '</div>'
    : ''

  const header = '<div class="recipe-card" data-rid="' + r.id + '">' +
    '<div class="recipe-card-header">' +
      '<div style="min-width:0;flex:1">' +
        '<div class="recipe-name">' + esc(r.name) + (r.archived ? ' <span style="font-size:10px;color:var(--text-4);font-weight:400">(archived)</span>' : '') + '</div>' +
        ((r.tags&&r.tags.length) ? '<div class="recipe-tags-preview" style="margin-top:4px">' + r.tags.map(t => '<span class="tag-chip-small">' + esc(t) + '</span>').join('') + '</div>' : '') +
        prepSummary +
        (r.clippedFrom ? '<div class="recipe-meta" style="margin-top:2px"><a href="' + esc(r.clippedFrom) + '" target="_blank" style="color:var(--accent);text-decoration:none;font-size:11px">&#128206; ' + esc((() => { try { return new URL(r.clippedFrom).hostname.replace('www.','') } catch(e) { return '' } })()) + '</a></div>' : '') +
      '</div>' +
      '<div class="chevron ' + (isExpanded ? 'open' : '') + '">▼</div>' +
    '</div>'

  if (!isExpanded) return header + '</div>'

  // ── COOK MODE: swaps in place of the card body ──
  if (state.cookMode && state.cookMode.recipeId === r.id) {
    return header + renderCookModeInline(r) + '</div>'
  }

  // ── EXPANDED: action buttons + tag editor + prep time box ──
  // No ingredients, no instructions — those live in Cook mode

  const tagChips = (r.tags||[]).map(t =>
    '<span class="tag-chip">' + esc(t) +
    '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe">×</button>' +
    '</span>'
  ).join('')
  const tagPickerBtn = '<button class="tag-picker-btn" data-picker-id="' + r.id + '" data-picker-ns="recipe">+ Tag</button>'
  const isPickerOpen = state.tagPickerOpen === r.id + '-recipe'
  const mealTags = getTagsForNamespace('recipe').slice().sort((a, b) => a.name.localeCompare(b.name))
  const pickerCategories = mealTags.filter(t => !t.tag_type || t.tag_type === 'category')
  const pickerStyles = mealTags.filter(t => t.tag_type === 'style')
  const hasTwoTiers = pickerStyles.length > 0
  const tagPicker = isPickerOpen ? (
    '<div class="tag-picker-popover" id="tag-picker-popover">' +
    (hasTwoTiers ? (
      (pickerCategories.length ? '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;padding:4px 0 2px">Category</div>' : '') +
      pickerCategories.map(t => {
        const checked = (r.tags||[]).includes(t.name)
        return '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe" ' + (checked?'checked':'') + ' />' + esc(t.name) + '</label>'
      }).join('') +
      (pickerStyles.length ? '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;padding:6px 0 2px;border-top:1px solid var(--border);margin-top:4px">Style</div>' : '') +
      pickerStyles.map(t => {
        const checked = (r.tags||[]).includes(t.name)
        return '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe" ' + (checked?'checked':'') + ' />' + esc(t.name) + '</label>'
      }).join('')
    ) : mealTags.map(t => {
      const checked = (r.tags||[]).includes(t.name)
      return '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + r.id + '" data-tag-ns="recipe" ' + (checked?'checked':'') + ' />' + esc(t.name) + '</label>'
    }).join('')) +
    '<div class="tag-picker-new">' +
      '<input class="tag-picker-input" id="new-tag-' + r.id + '-recipe" placeholder="New tag..." />' +
      '<button class="tag-picker-add" data-new-tag-item="' + r.id + '" data-new-tag-ns="recipe">Add</button>' +
    '</div>' +
    '</div>'
  ) : ''

  // Prep time box
  const prepBox = pt ? (
    '<div class="prep-time-box" style="margin-top:10px">' +
      '<div class="prep-time-header">' +
        '<span style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px">Prep time</span>' +
        '<button class="prep-time-refresh" data-refresh-prep="' + r.id + '">' + (state.refreshingPrepId === r.id ? '...' : '↻') + '</button>' +
      '</div>' +
      '<div class="prep-time-grid">' +
        '<div class="prep-time-stat"><div class="prep-time-val">' + pt.active_min + ' min</div><div class="prep-time-label">Active</div></div>' +
        (pt.passive_min > 0 ? '<div class="prep-time-stat"><div class="prep-time-val">' + pt.passive_min + ' min</div><div class="prep-time-label">Passive</div></div>' : '') +
        '<div class="prep-time-stat"><div class="prep-time-val">' + (pt.difficulty||'?') + '</div><div class="prep-time-label">Difficulty</div></div>' +
        '<div class="prep-time-stat"><div class="prep-time-val">' + (pt.active_min + (pt.passive_min||0)) + ' min</div><div class="prep-time-label">Total</div></div>' +
      '</div>' +
      (pt.make_ahead && pt.make_ahead !== 'none' && pt.make_ahead !== 'None' ? '<div class="prep-time-row"><span class="prep-time-key">Make-ahead:</span> ' + esc(pt.make_ahead) + '</div>' : '') +
      (pt.multitask ? '<div class="prep-time-row"><span class="prep-time-key">Multitask tip:</span> ' + esc(pt.multitask) + '</div>' : '') +
    '</div>'
  ) : (
    '<div class="prep-time-box prep-time-empty" style="margin-top:10px">' +
      '<button class="prep-time-estimate-btn" data-estimate-prep="' + r.id + '">' +
        (state.estimatingPrepId === r.id ? '⏳ Estimating...' : '⏱ Estimate prep time') +
      '</button>' +
    '</div>'
  )

  const body = '<div class="recipe-body">' +
    // Source link
    (r.clippedFrom ? '<div class="recipe-link" style="margin-bottom:8px"><a href="' + esc(r.clippedFrom) + '" target="_blank">View original ↗</a></div>' : '') +
    // Tag picker popover only — chips shown in collapsed header, no duplication here
    (tagPicker ? '<div style="position:relative">' + tagPicker + '</div>' : '') +
    // Prep time
    prepBox +
    // Cook — full width, same height as other buttons
    '<div class="recipe-actions" style="margin-top:12px">' +
      '<button class="ra-btn" data-cook-mode="' + r.id + '" style="flex:1;width:100%;background:var(--black);color:white;border-color:var(--black);font-size:11px;padding:7px 4px;font-weight:700">Cook</button>' +
    '</div>' +
    // Secondary actions — List, Week, Log, Tag, Archive, Del
    '<div class="recipe-actions" style="margin-top:6px">' +
      '<button class="ra-btn" data-shop="' + r.id + '" style="flex:1;font-size:11px;padding:7px 4px;color:var(--text-2);border-color:var(--border-strong)">+ List</button>' +
      '<button class="ra-btn" data-add-to-week="' + r.id + '" data-add-name="' + esc(r.name) + '" style="flex:1;font-size:11px;padding:7px 4px;color:var(--text-2);border-color:var(--border-strong)">+ Week</button>' +
      '<button class="ra-btn" data-log-recipe="' + r.id + '" style="flex:1;font-size:11px;padding:7px 4px;color:var(--text-2);border-color:var(--border-strong)">Log</button>' +
      '<button class="tag-picker-btn" data-picker-id="' + r.id + '" data-picker-ns="recipe" style="flex:1;font-size:11px;padding:7px 4px;border-radius:8px;border:1.5px solid var(--border-strong);background:var(--white);cursor:pointer;font-family:inherit;color:var(--text-2)">+ Tag</button>' +
      (r.archived
        ? '<button class="ra-btn" data-restore-recipe="' + r.id + '" style="flex:1;font-size:11px;padding:7px 4px;color:var(--text-2);border-color:var(--border-strong)">Restore</button>'
        : '<button class="ra-btn" data-archive-recipe="' + r.id + '" style="flex:1;font-size:11px;padding:7px 4px;color:var(--text-2);border-color:var(--border-strong)">Archive</button>') +
      '<button class="ra-btn ra-del" data-del="' + r.id + '" style="flex:0.8;font-size:11px;padding:7px 4px">Del</button>' +
    '</div>' +
  '</div>'

  return header + body + '</div>'
}
function renderSearchBar(id, value, placeholder) {
  return '<div class="tab-search-wrap">' +
    '<input class="tab-search-input" id="' + id + '" placeholder="' + placeholder + '" value="' + esc(value) + '" />' +
    (value ? '<button class="tab-search-clear" data-clear-search="' + id + '">×</button>' : '') +
  '</div>'
}

function renderRecipes() {
  const search = (state.recipeSearch || '').toLowerCase()
  const activeTags = state.activeTagFilters['recipe']
  let allFiltered
  if (!activeTags) {
    allFiltered = state.recipes
  } else {
    const activeCategories = [...activeTags].filter(tag => {
      const t = state.allTags.find(x => x.name === tag && x.namespace === 'recipe')
      return !t?.tag_type || t.tag_type === 'category'
    })
    const activeStyles = [...activeTags].filter(tag => {
      const t = state.allTags.find(x => x.name === tag && x.namespace === 'recipe')
      return t?.tag_type === 'style'
    })
    allFiltered = state.recipes.filter(r => {
      const rTags = r.tags || []
      const categoryMatch = activeCategories.length === 0 || activeCategories.some(tag => rTags.includes(tag))
      const styleMatch = activeStyles.length === 0 || activeStyles.some(tag => rTags.includes(tag))
      return categoryMatch && styleMatch
    })
  }
  let filtered = allFiltered.filter(r => state.showArchived ? r.archived : !r.archived)
  if (search) filtered = filtered.filter(r => r.name.toLowerCase().includes(search) || (r.ingredients||'').toLowerCase().includes(search))

  // Sort
  const sort = state.recipeSort || 'newest'
  if (sort === 'az') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  else if (sort === 'za') filtered = [...filtered].sort((a, b) => b.name.localeCompare(a.name))
  // 'newest' is default order from Supabase (created_at desc)

  const archivedCount = state.recipes.filter(r => r.archived).length
  const isListView = state.recipeView === 'list'

  // Compact list row renderer
  const renderListRow = (r) => {
    const isExpanded = state.expandedRecipe === r.id
    const tags = (r.tags || []).slice(0, 3).map(t => `<span style="background:var(--accent-light);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;border:1px solid var(--accent-mid)">${esc(t)}</span>`).join('')
    if (!isExpanded) {
      return `<div class="recipe-list-row" data-expand-recipe="${r.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:0.5px solid var(--border);cursor:pointer;background:var(--white)">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div>
          ${tags ? `<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">${tags}</div>` : ''}
        </div>
        <div style="font-size:18px;color:var(--text-3);flex-shrink:0">›</div>
      </div>`
    }
    // Expanded — show full card inline
    return `<div style="border-bottom:2px solid var(--accent)">${renderRecipeCard(r)}</div>`
  }

  const _tonightHtml = renderTonightCard()
  return `
    <div class="tab-content">
      ${_tonightHtml}
      <div class="section-header">
        <div class="section-title">My Recipe Box</div>
        <div style="display:flex;gap:6px">
          <button class="add-btn" id="scan-recipe-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--accent-mid)">Scan</button>
          <button class="add-btn" id="clip-url-btn-recipes" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--accent-mid)">Clip</button>
          <button class="add-btn" id="paste-recipe-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--accent-mid)">Paste</button>
          <button class="add-btn" id="add-recipe-btn">+ Add</button>
          <button class="add-btn" id="organize-tags-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--accent-mid)">Tags</button>
        </div>
      </div>
      <input type="file" id="scan-file-input" accept="image/*" capture="environment" style="display:none" />
      ${renderSearchBar('recipe-search', state.recipeSearch || '', 'Search recipes...')}
      ${state.allTags.some(t => t.namespace === 'recipe') ? renderTagFilterChips('recipe', 'Meal') : ''}

      <!-- Sort + View controls -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
        <div style="display:flex;gap:4px">
          <button class="recipe-sort-btn ${sort==='newest'?'active':''}" data-sort="newest" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='newest'?'var(--accent)':'var(--border)'};background:${sort==='newest'?'var(--accent)':'white'};color:${sort==='newest'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">Recent</button>
          <button class="recipe-sort-btn ${sort==='az'?'active':''}" data-sort="az" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='az'?'var(--accent)':'var(--border)'};background:${sort==='az'?'var(--accent)':'white'};color:${sort==='az'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">A→Z</button>
          <button class="recipe-sort-btn ${sort==='za'?'active':''}" data-sort="za" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='za'?'var(--accent)':'var(--border)'};background:${sort==='za'?'var(--accent)':'white'};color:${sort==='za'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">Z→A</button>
        </div>
        <div style="display:flex;gap:4px">
          <button id="view-cards-btn" title="Card view" style="font-size:16px;padding:4px 8px;border-radius:6px;border:1.5px solid ${!isListView?'var(--accent)':'var(--border)'};background:${!isListView?'var(--sage4)':'white'};cursor:pointer">⊟</button>
          <button id="view-list-btn" title="List view" style="font-size:16px;padding:4px 8px;border-radius:6px;border:1.5px solid ${isListView?'var(--accent)':'var(--border)'};background:${isListView?'var(--sage4)':'white'};cursor:pointer">☰</button>
        </div>
      </div>

      ${archivedCount > 0 ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <button id="toggle-archived-btn" style="font-size:12px;color:var(--text-3);background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-family:inherit">
            ${state.showArchived ? '← Back to recipes' : '📦 Archived (' + archivedCount + ')'}
          </button>
        </div>
      ` : ''}
      ${state.addRecipeModal ? `
        <div class="recipe-add-box">
          <input id="r-name" placeholder="Recipe name" value="${esc(state.addRecipeModalDraft.name)}" />
          <div class="clip-field-label">Ingredients</div>
          <textarea id="r-ingredients" placeholder="One ingredient per line...">${esc(state.addRecipeModalDraft.ingredients)}</textarea>
          <div class="clip-field-label">Instructions</div>
          <textarea id="r-instructions" placeholder="Step by step...">${esc(state.addRecipeModalDraft.instructions)}</textarea>
          ${getTagsForNamespace('recipe').length > 0 ? `
          <div class="clip-field-label">Tags</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
            ${getTagsForNamespace('recipe').map(t =>
              `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;background:var(--gray-100);border-radius:8px;padding:8px 10px;min-width:0">
                <input type="checkbox" class="r-tag-check" data-tag="${esc(t.name)}" ${state.addRecipeModalDraft.tags.includes(t.name) ? 'checked' : ''} style="accent-color:var(--accent);flex-shrink:0;width:16px;height:16px" />
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span>
              </label>`
            ).join('')}
          </div>` : ''}
          <div class="add-row" style="margin-top:8px">
            <input id="r-notes" placeholder="Note (optional)" style="flex:1" value="${esc(state.addRecipeModalDraft.notes)}" />
            <button class="add-btn" id="r-save-btn">Save</button>
            <button class="clip-cancel-btn" id="r-cancel-btn">Cancel</button>
          </div>
        </div>
      ` : ''}
      ${filtered.length === 0 && !state.addRecipeModal ? `
        <div class="empty-state">${state.activeCategory !== 'All' ? `No ${state.activeCategory} recipes yet.` : 'No recipes yet.<br>Add one above or use the Chrome extension<br>to clip from any recipe website!'} 🥗</div>
      ` : isListView
          ? `<div style="border-radius:12px;overflow:hidden;border:1px solid var(--cream3)">${filtered.map(r => renderListRow(r)).join('')}</div>`
          : filtered.map(r => renderRecipeCard(r)).join('')
      }
    </div>`
}

function renderPantry() {
  const locationTags = state.activeTagFilters['location']
  const search = (state.pantrySearch || '').toLowerCase()
  const filtered = state.pantry.filter(item => {
    if (locationTags && locationTags.has('__untagged__')) return !(item.tags||[]).length && (!search || item.name.toLowerCase().includes(search))
    return (!locationTags || locationTags.size === 0 || [...locationTags].some(t => (item.tags||[]).includes(t))) &&
      (!search || item.name.toLowerCase().includes(search))
  })
  return '<div class="tab-content">' +
    renderSearchBar('pantry-search', state.pantrySearch || '', 'Search pantry...') +
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
      '<span style="font-size:10px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Tag:</span>' +
      getTagsForNamespace('location').map(t =>
        '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="pantry-new-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--accent)" />' +
        esc(t.name) + '</label>'
      ).join('') +
      '</div>'
    : '') +
    '</div>' +
    (state.pantry.length === 0 ? '<div class="empty-state">Your pantry is empty.<br>Add staples you keep on hand!</div>' :
      '<div class="pantry-list">' +
      filtered.map(function(item) {
        const chips = (item.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + item.id + '" data-tag-ns="location">x</button></span>').join('')
        const pickerId = item.id + '-location'
        const isOpen = state.tagPickerOpen === pickerId
        const pantryTags = getTagsForNamespace('location').slice().sort((a, b) => a.name.localeCompare(b.name))
        const picker = isOpen ? ('<div class="tag-picker-popover" id="tag-picker-popover">' + pantryTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + item.id + '" data-tag-ns="location" ' + ((item.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + item.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + item.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
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

// ── SHOP LIST RENDERING ───────────────────────────────────────────────────────

function renderShopItems(items) {
  return items.map(function(i) {
    const chips = (i.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + i.id + '" data-tag-ns="location">x</button></span>').join('')
    const pickerId = i.id + '-location'
    const isOpen = state.tagPickerOpen === pickerId
    const storeTags = getTagsForNamespace('location').slice().sort((a, b) => a.name.localeCompare(b.name))
    const picker = isOpen ? ('<div class="tag-picker-popover" id="tag-picker-popover">' + storeTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + i.id + '" data-tag-ns="location" ' + ((i.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + i.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + i.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
    const isEditingS = state.editingShopId === String(i.id)

    const isChecked = !!i.have

    return '<div class="shop-row" style="' + (isChecked ? 'opacity:0.6' : '') + '">' +
      '<div class="shop-check' + (isChecked ? ' shop-check-done' : '') + '" data-check="' + i.id + '"></div>' +
      '<div class="shop-item-main">' +
      (isEditingS ?
        '<input class="shop-edit-name" data-edit-shop-name="' + i.id + '" value="' + esc(i.name) + '" style="width:100%;padding:5px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-size:13px;font-family:inherit;margin-bottom:4px" />' +
        '<button class="add-btn" data-save-shop="' + i.id + '" style="padding:4px 10px;font-size:11px">Save</button>'
      :
        '<div class="shop-item-name" data-edit-shop="' + i.id + '" style="cursor:pointer;' + (isChecked ? 'text-decoration:line-through;color:var(--text-4)' : '') + '" title="Tap to edit">' + esc(i.name) + '</div>'
      ) +
      '<div class="shop-item-tags" style="position:relative">' +
        (!isChecked ? chips + '<button class="tag-picker-btn" data-picker-id="' + i.id + '" data-picker-ns="location">+ Tag</button>' + picker : '') +
        // Pantry button always visible — moves to cart AND adds to pantry
        '<button class="ra-btn ra-log" data-move-to-pantry="' + i.id + '" style="font-size:10px;padding:3px 8px' + (isChecked ? ';opacity:1' : '') + '">🧺 Pantry</button>' +
      '</div>' +
      '</div>' +
      '<button class="remove-btn" data-shop-del="' + i.id + '">x</button>' +
    '</div>'
  }).join('')
}

function renderShop() {
  const tonightCard = renderTonightCard()
  const locationTags = state.activeTagFilters['location']
  const search = (state.shopSearch || '').toLowerCase()

  const need = sortShopList(state.shopList.filter(i => {
    if (!i.have) {
      if (locationTags && locationTags.has('__untagged__')) return !(i.tags||[]).length && (!search || i.name.toLowerCase().includes(search))
      return (!locationTags || locationTags.size === 0 || [...locationTags].some(t => (i.tags||[]).includes(t))) &&
        (!search || i.name.toLowerCase().includes(search))
    }
    return false
  }))
  const done = state.shopList.filter(i => i.have)

  return '<div class="tab-content">' +
    tonightCard +
    '<button id="shop-view-pantry-btn" style="width:100%;margin-bottom:12px;padding:10px;background:var(--white);border:1.5px solid var(--border-strong);border-radius:10px;font-size:13px;font-weight:600;color:var(--text-2);cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px">🧺 View Pantry</button>' +
    '<div class="shop-header">' +
      '<div class="section-title">Shopping List</div>' +
      '<div style="display:flex;gap:6px">' +
        (state.shopList.length > 0 ? '<button class="icon-btn" id="shop-copy-btn">📤 Share</button>' : '') +
        (done.length > 0 ? '<button class="clear-pantry-btn" id="shop-clear-checked" style="background:var(--gray-100);color:var(--text-2);border:1px solid var(--border)">Clear checked (' + done.length + ')</button>' : '') +
        (state.shopList.length > 0 ? '<button class="clear-pantry-btn" id="shop-clear">Clear all</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="shop-add-row">' +
      '<input id="shop-manual-input" placeholder="Add item manually..." />' +
      '<button class="add-btn" id="shop-manual-add">+ Add</button>' +
    '</div>' +
    (state._shopPantryWarning ? (
      '<div style="background:#fff8e6;border:1.5px solid var(--gold);border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13px">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:6px">🧺 Already in pantry: <em>' + esc(state._shopPantryWarning) + '</em></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="add-btn" id="shop-add-anyway" style="font-size:12px;padding:5px 12px">Add anyway</button>' +
          '<button class="modal-cancel" id="shop-skip-item" style="font-size:12px;padding:5px 12px">Skip</button>' +
        '</div>' +
      '</div>'
    ) : '') +
    (getTagsForNamespace('location').length > 0 ?
      '<div style="margin-top:6px;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' +
      '<span style="font-size:10px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Tag:</span>' +
      getTagsForNamespace('location').map(t =>
        '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="shop-new-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--accent)" />' +
        esc(t.name) + '</label>'
      ).join('') +
      '</div>'
    : '') +
    renderSearchBar('shop-search', state.shopSearch || '', 'Search list...') +
    (state.shopList.length === 0 ? '<div class="empty-state">Your list is empty.<br>Open a recipe and tap <strong>Add to list</strong>!</div>' : '') +
    (state.allTags.some(t => t.namespace === 'location') ? renderTagFilterChips('location', 'Store') : '') +
    (need.length > 0 ?
      '<div class="shop-got-it-bar">' +
        '<div class="shop-got-it-text">' + need.length + ' item' + (need.length!==1?'s':'') + ' to buy</div>' +
        '<button class="shop-got-it-btn" id="shop-got-it">Got it all!</button>' +
      '</div>' +
      renderShopItems(need)
    : (state.shopList.length > 0 && need.length === 0 && done.length > 0 ? '<div style="font-size:13px;color:var(--text-3);padding:12px 0;text-align:center">✅ All done! Items will clear in 1 hour.</div>' : '')) +
    // Checked / crossed-off items
    (done.length > 0 ?
      '<div style="margin-top:14px;border-top:1px solid var(--cream3);padding-top:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<div style="font-size:10px;color:var(--text-4);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">In cart (' + done.length + ')</div>' +
          '<button class="clear-pantry-btn" id="shop-clear-cart" style="font-size:10px;padding:3px 8px">Remove all</button>' +
        '</div>' +
        renderShopItems(done) +
      '</div>'
    : '') +
  '</div>'
}

function renderLog() {
  try {
    return renderLogInner()
  } catch(e) {
    console.error('renderLog error:', e)
    return '<div class="tab-content"><div style="padding:20px;color:red">Log tab error: ' + e.message + '</div></div>'
  }
}

function renderLogInner() {
  const offset = state.logDayOffset || 0
  const now = new Date()
  const viewedDate = new Date(now)
  viewedDate.setDate(now.getDate() + offset)
  const viewedDateStr = viewedDate.toLocaleDateString('sv') // YYYY-MM-DD in local time
  const isToday = offset === 0
  state._viewedDateStr = viewedDateStr // expose for handlers

  // Get the log and exercise for the viewed day
  const viewedLog = isToday ? state.log : (state.viewedDayLog || [])
  const viewedExercise = isToday ? state.exerciseLog : (state.viewedDayExercise || [])

  const cals = viewedLog.reduce((s,e) => s + (e.calories||0), 0)
  const burned = viewedExercise.reduce((s,e) => s + (e.calories_burned||0), 0)
  const net = cals - burned
  const goal = state.goals.calories
  const rem = goal - net

  // Day label
  const dayLabel = isToday ? 'Today' : offset === -1 ? 'Yesterday'
    : viewedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const toLocalDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
  const today = toLocalDateStr(now)
  const weekDays = []
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    weekDays.push(toLocalDateStr(d))
  }

  // Build byDate using local date of each entry (same logic as fetchLogForDate)
  const byDate = {}
  ;(state.historyLog || []).forEach(e => {
    const d = new Date(e.logged_at)
    // Use local date components — same as fetchLogForDate's T00:00:00 local boundary
    const key = toLocalDateStr(d)
    if (!byDate[key]) byDate[key] = []
    byDate[key].push(e)
  })

  const byDateExercise = {}
  ;(state.historyExerciseLog || []).forEach(e => {
    const d = new Date(e.logged_at)
    const key = toLocalDateStr(d)
    if (!byDateExercise[key]) byDateExercise[key] = []
    byDateExercise[key].push(e)
  })

  // Override with freshly-fetched day data when available (guaranteed accurate)
  if (state.viewedDayLog && state._viewedDateStr) {
    byDate[state._viewedDateStr] = state.viewedDayLog
  }
  if (state.viewedDayExercise && state._viewedDateStr) {
    byDateExercise[state._viewedDateStr] = state.viewedDayExercise
  }

  // Pre-fetch all 7 days if we don't have them cached yet
  if (!state._weekDataLoaded) {
    state._weekDataLoaded = true
    Promise.all(weekDays.map(async d => {
      const [log, ex] = await Promise.all([db.fetchLogForDate(d), db.fetchExerciseForDate(d)])
      state._weekByDate = state._weekByDate || {}
      state._weekExByDate = state._weekExByDate || {}
      state._weekByDate[d] = log
      state._weekExByDate[d] = ex
      render()
    }))
  }
  // Use pre-fetched week data if available (most accurate)
  if (state._weekByDate) {
    weekDays.forEach(d => {
      if (state._weekByDate[d]) byDate[d] = state._weekByDate[d]
      if (state._weekExByDate && state._weekExByDate[d]) byDateExercise[d] = state._weekExByDate[d]
    })
  }

  const weeklyIn = weekDays.reduce((sum, d) => sum + (byDate[d] || []).reduce((s,e) => s+(e.calories||0), 0), 0)
  const weeklyOut = weekDays.reduce((sum, d) => sum + (byDateExercise[d] || []).reduce((s,e) => s+(e.calories_burned||0), 0), 0)

  const weeklyNet = weeklyIn - weeklyOut
  const weeklyGoal = goal * 7
  const weeklyDiff = weeklyNet - weeklyGoal
  const deficitSurplus = weeklyDiff < 0
    ? { label: Math.abs(weeklyDiff).toLocaleString() + ' cal deficit', color: 'var(--accent)', bg: 'var(--sage4)' }
    : weeklyDiff > 0
    ? { label: weeklyDiff.toLocaleString() + ' cal surplus', color: 'var(--terra)', bg: '#fff5f2' }
    : { label: 'On target', color: 'var(--accent)', bg: 'var(--sage4)' }

  const search = state.logSearch || ''
  const logTagFilter = state.logTagFilter || null
  const recipeTags = getTagsForNamespace('recipe')
  const recipeResults = (search || logTagFilter)
    ? state.recipes.filter(r =>
        (!search || r.name.toLowerCase().includes(search.toLowerCase())) &&
        (!logTagFilter || (r.tags||[]).includes(logTagFilter))
      ).slice(0, 8)
    : []
  // Today entries
  const logEntries = viewedLog.length === 0
    ? '<div class="empty-state" style="padding:16px 0">Nothing logged ' + (isToday ? 'yet today' : 'this day') + '!</div>'
    : viewedLog.map(e => {
        const isEditing = state.editingLogId === e.id
        if (isEditing) {
          return '<div class="log-entry" style="flex-direction:column;align-items:stretch;gap:6px">' +
            '<input id="edit-log-food-' + e.id + '" value="' + esc(e.food) + '" style="font-size:13px;padding:6px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-family:inherit" />' +
            '<div style="display:flex;gap:6px;align-items:center">' +
              '<input id="edit-log-cals-' + e.id + '" type="number" value="' + (e.calories||0) + '" style="width:80px;padding:6px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-family:inherit;font-size:13px" />' +
              '<span style="font-size:11px;color:var(--text-3)">kcal</span>' +
              '<button class="add-btn" data-save-log="' + e.id + '" style="flex:1">Save</button>' +
              '<button class="modal-cancel" data-cancel-log="' + e.id + '" style="padding:6px 10px">Cancel</button>' +
            '</div>' +
          '</div>'
        }
        return '<div class="log-entry">' +
          '<div style="flex:1" data-edit-log="' + e.id + '" style="cursor:pointer">' +
            '<div class="log-food" style="cursor:pointer" data-edit-log="' + e.id + '">' + esc(e.food) + '</div>' +
            '<div class="log-cal-row-entry">' +
              '<span class="log-cal ' + (e.calories === 0 ? 'log-cal-zero' : '') + '">' +
                (e.calories === 0
                  ? '<button class="log-add-cals-btn" data-add-cals-id="' + e.id + '">+ Add calories</button>'
                  : e.calories + ' kcal') +
              '</span>' +
              (e.calories > 0 ? '<button class="log-breakdown-btn" data-breakdown-id="' + e.id + '">?</button>' : '') +
            '</div>' +
            (state.logBreakdownId === e.id && e.breakdown ?
              '<div class="log-breakdown-text">' + esc(e.breakdown) + '</div>' : '') +
          '</div>' +
          '<button class="remove-btn" data-log-del="' + e.id + '" style="flex-shrink:0">x</button>' +
        '</div>'
      }).join('')

  // Weekly breakdown rows
  const weekRows = weekDays.map(d => {
    const entries = byDate[d] || []
    const exercise = byDateExercise[d] || []
    const dayCalsIn = entries.reduce((s, e) => s + (e.calories || 0), 0)
    const dayBurned = exercise.reduce((s, e) => s + (e.calories_burned || 0), 0)
    const dayCals = dayCalsIn - dayBurned
    const isDayToday = d === today
    const diff = dayCals - goal
    const wDayLabel = isDayToday ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const foods = entries.slice(0, 3).map(e => esc(e.food)).join(', ') + (entries.length > 3 ? ' +' + (entries.length - 3) + ' more' : '')
    const barPct = Math.min((dayCals / goal) * 100, 100)
    const barColor = diff > 200 ? 'var(--terra)' : diff > 0 ? 'var(--gold)' : 'var(--forest2)'
    return '<div style="padding:8px 0;border-bottom:1px solid var(--cream2)' + (isDayToday ? ';background:var(--accent-light);border-radius:8px;padding:8px;margin:-2px 0' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
        '<span style="font-size:12px;font-weight:' + (isDayToday ? '700' : '500') + ';color:' + (isDayToday ? 'var(--accent)' : 'var(--ink)') + '">' + wDayLabel + '</span>' +
        '<span style="font-size:12px;font-weight:600;color:var(--text-2)">' + (dayCalsIn > 0 ? dayCals + ' net cal' + (dayBurned > 0 ? ' <span style="font-size:10px;color:var(--accent)">(-' + dayBurned + ' burned)</span>' : '') : '--') + '</span>' +
      '</div>' +
      (dayCalsIn > 0 ? '<div style="height:3px;background:var(--gray-200);border-radius:2px;margin-bottom:3px"><div style="height:100%;width:' + barPct + '%;background:' + barColor + ';border-radius:2px"></div></div>' : '') +
      (foods ? '<div style="font-size:10px;color:var(--text-3)">' + foods + '</div>' : '') +
    '</div>'
  }).join('')

  return '<div class="tab-content" id="log-tab-content">' +
    '<button id="log-goals-btn" style="width:100%;margin-bottom:12px;padding:10px 14px;background:var(--black);color:white;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:space-between"><span>⚙️ Goals &amp; Targets</span><span style="opacity:0.55;font-size:11px">Calories · Weight · Activity →</span></button>' +

    // 1. Day navigation + today summary banner
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<button class="cal-nav" id="log-prev-day">&#8249;</button>' +
      '<div style="text-align:center">' +
        '<div style="font-size:15px;font-weight:700;color:var(--accent)">' + dayLabel + '</div>' +
        (!isToday ? '<div style="font-size:11px;color:var(--text-3)">' + viewedDate.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) + '</div>' : '') +
      '</div>' +
      '<button class="cal-nav" id="log-next-day" ' + (isToday ? 'disabled style="opacity:0.3"' : '') + '>&#8250;</button>' +
    '</div>' +

    // 2. Daily summary banner
    '<div class="log-total">' +
      '<div>' +
        '<div class="log-total-label">' + (isToday ? 'Today' : dayLabel) + '</div>' +
        '<div class="log-total-sub">' + (rem > 0 ? rem + ' remaining' : Math.abs(rem) + ' over goal') + '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        (burned > 0 ?
          '<div style="font-size:11px;color:var(--text-3)">&#127869; ' + cals + ' in &nbsp;&#127939; ' + burned + ' out</div>' +
          '<div><span class="log-total-val">' + net + '</span><span class="log-total-goal"> net / ' + goal + '</span></div>'
        :
          '<div><span class="log-total-val">' + cals + '</span><span class="log-total-goal"> / ' + goal + '</span></div>'
        ) +
      '</div>' +
    '</div>' +

    // 3. Log weight input
    (state.goals.target_weight ? (
      '<div class="log-add-row" style="margin-top:10px;margin-bottom:10px">' +
        '<input id="log-weight-input" type="number" step="0.1" placeholder="Log weight (lbs)" style="flex:1" value="' + ((() => {
          const existing = (state.weightLog || []).find(e => new Date(e.logged_at).toLocaleDateString('sv') === viewedDateStr)
          return existing ? existing.weight : ''
        })()) + '" />' +
        '<button class="add-btn" id="log-weight-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--forest2)">' + ((state.weightLog || []).find(e => new Date(e.logged_at).toLocaleDateString('sv') === viewedDateStr) ? '&#9998; Update' : '&#9881; Log') + ' Weight</button>' +
      '</div>'
    ) : '') +

    // 4. Today's Meals — what's already logged
    '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px">&#127869; ' + (isToday ? "Today's" : dayLabel + "'s") + ' meals</div>' +
    logEntries +

    // 5. Log Meals — structured form
    '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 8px">Log Meals</div>' +
    '<div style="background:var(--gray-100);border-radius:12px;padding:12px;margin-bottom:10px">' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
        '<input id="log-qty" placeholder="Qty" type="number" min="0" step="0.1" style="width:60px;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;text-align:center" />' +
        '<select id="log-unit" style="width:90px;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:white">' +
          '<option value="">unit</option>' +
          '<option value="oz">oz</option>' +
          '<option value="g">g</option>' +
          '<option value="lbs">lbs</option>' +
          '<option value="cup">cup</option>' +
          '<option value="tbsp">tbsp</option>' +
          '<option value="tsp">tsp</option>' +
          '<option value="piece">piece(s)</option>' +
          '<option value="slice">slice(s)</option>' +
          '<option value="serving">serving(s)</option>' +
        '</select>' +
        '<input id="log-food" placeholder="What did you eat?" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit" />' +
      '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<input id="log-notes" placeholder="Notes: e.g. huge Chicago deep dish slices, extra cheese..." style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit" />' +
        '<button class="add-btn" id="log-add-btn" style="white-space:nowrap">+ Add</button>' +
      '</div>' +
    '</div>' +
    (!isToday ? '<div style="font-size:10px;color:var(--text-3);margin-bottom:8px;font-style:italic">Adding to ' + dayLabel + '</div>' : '') +
    '<div class="log-search-wrap">' +
      '<input id="log-search" class="log-search-input" placeholder="Search recipes to log..." value="' + esc(search) + '" />' +
      (recipeResults.length ? '<div class="log-search-results">' +
        recipeResults.map(r =>
          '<button class="log-search-result" data-log-recipe="' + r.id + '" data-log-recipe-name="' + esc(r.name) + '">' + esc(r.name) + (r.tags&&r.tags.length ? ' <span style="font-size:10px;color:var(--text-3)">(' + r.tags.join(', ') + ')</span>' : '') + '</button>'
        ).join('') +
        '<button class="log-search-result" id="log-search-clear" style="color:var(--text-3);font-style:italic">Clear search</button>' +
      '</div>' : '') +
    '</div>' +
    (recipeTags.length > 0 ?
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">' +
        '<button class="tag-filter-chip ' + (!logTagFilter ? 'active' : '') + '" data-log-tag="">All</button>' +
        recipeTags.map(t => '<button class="tag-filter-chip ' + (logTagFilter === t.name ? 'active' : '') + '" data-log-tag="' + esc(t.name) + '">' + esc(t.name) + '</button>').join('') +
      '</div>'
    : '') +

    // 6. Exercise
    '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 6px">&#127939; Exercise</div>' +
    '<div class="log-add-row">' +
      '<input id="log-exercise" placeholder="e.g. swam 1 hour, walked 30 min" style="flex:1" />' +
      '<button class="add-btn" id="log-exercise-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--forest2)">+ Add</button>' +
    '</div>' +
    (viewedExercise && viewedExercise.length > 0 ?
      viewedExercise.map(e =>
        '<div class="log-entry">' +
          '<div style="flex:1">' +
            '<div class="log-food">' + esc(e.activity) + '</div>' +
            '<div class="log-cal-row-entry">' +
              '<span class="log-cal" style="color:var(--accent)">-' + e.calories_burned + ' kcal burned</span>' +
              (e.calories_burned > 0 ? '<button class="log-breakdown-btn" data-ex-breakdown-id="' + e.id + '">?</button>' : '') +
            '</div>' +
            (state.logBreakdownId === 'ex-' + e.id && e.breakdown ?
              '<div class="log-breakdown-text">' + esc(e.breakdown) + '</div>' : '') +
          '</div>' +
          '<button class="remove-btn" data-ex-del="' + e.id + '">x</button>' +
        '</div>'
      ).join('')
    : '<div style="font-size:12px;color:var(--text-4);padding:4px 0 8px">No exercise logged' + (isToday ? ' today' : ' this day') + '</div>') +

    // 7. Weight progress chart
    renderWeightProgress() +

    // Today's calorie summary (compact, between chart and log weight)
    '<div style="background:var(--gray-100);border-radius:10px;padding:8px 14px;margin-top:10px;display:flex;justify-content:space-between;align-items:center">' +
      '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Today</div>' +
      '<div style="font-size:13px;font-weight:700;color:var(--text)">' +
        (burned > 0
          ? cals + ' in · ' + burned + ' burned · <span style="color:' + (rem >= 0 ? 'var(--accent)' : 'var(--terra)') + '">' + net + ' net</span>'
          : '<span style="color:' + (rem >= 0 ? 'var(--accent)' : 'var(--terra)') + '">' + cals + '</span> cal'
        ) +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-3)">' + (rem >= 0 ? rem + ' left' : Math.abs(rem) + ' over') + ' · goal ' + goal + '</div>' +
    '</div>' +

    // 8. Last 7 days summary bar
    '<div style="background:' + deficitSurplus.bg + ';border-radius:10px;padding:8px 12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">' +
      '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Last 7 days</div>' +
      '<div style="font-size:12px;font-weight:700;color:' + deficitSurplus.color + '">' + deficitSurplus.label + '</div>' +
      '<div style="font-size:11px;color:var(--text-3)">' + weeklyIn.toLocaleString() + ' / ' + weeklyGoal.toLocaleString() + ' cal</div>' +
    '</div>' +

    // 9. Day-by-day breakdown of last 7 days
    '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 6px">Day by day</div>' +
    weekRows +

  '</div>'
}

function renderWeightProgress() {
  const { target_weight, calories: dailyCals, weight: goalsWeight, goal_start_date } = state.goals
  const weightLog = state.weightLog || []

  // Start weight = goals weight field (what user entered as their starting weight)
  // Fall back to first weigh-in if goals weight not set
  const startWeight = parseFloat(goalsWeight || (weightLog.length > 0 ? weightLog[0].weight : 0))
  if (!startWeight || !target_weight || startWeight <= parseFloat(target_weight)) return ''

  // Latest weigh-in
  const latestWeight = weightLog.length > 0 ? parseFloat(weightLog[weightLog.length-1].weight) : startWeight
  const lostSoFar = startWeight - latestWeight
  const toGo = Math.max(latestWeight - parseFloat(target_weight), 0)

  // Start date from goals
  const startDate = goal_start_date
    ? new Date(goal_start_date + 'T12:00:00')
    : (weightLog.length > 0 ? new Date(weightLog[0].logged_at) : new Date())
  startDate.setHours(0, 0, 0, 0)

  // Projection
  const tdee = calcTDEE(latestWeight, state.goals.height_inches, state.goals.age, state.goals.activity_level)
  const projection = tdee ? calcProjection(tdee, startWeight, target_weight, dailyCals) : null

  // End date = projected finish or 6 months
  let endDate = new Date(startDate)
  if (projection) {
    endDate.setDate(startDate.getDate() + projection.days)
  } else {
    endDate.setMonth(startDate.getMonth() + 6)
  }

  // Compare updated plan end date vs original to show ahead/behind message
  let nudgeMsg = '', nudgeColor = 'var(--ink3)'

  const totalDays = Math.max(Math.round((endDate - startDate) / 86400000), 30)
  const lbsPerDay = projection ? (startWeight - parseFloat(target_weight)) / projection.days : 0

  // Original projected line — starts at startWeight on startDate, goes to target
  const projPoints = projection ? Array.from({length: Math.min(totalDays, projection.days) + 1}, (_, i) => ({
    day: i,
    weight: Math.max(parseFloat((startWeight - lbsPerDay * i).toFixed(2)), parseFloat(target_weight))
  })) : []

  // Adjusted projection — same daily rate, but starting from current weight at today
  const todayDay = Math.round((new Date() - startDate) / 86400000)
  const daysToTargetFromNow = lbsPerDay > 0 ? Math.ceil((latestWeight - parseFloat(target_weight)) / lbsPerDay) : 0
  const adjustedProjPoints = (projection && latestWeight !== startWeight && daysToTargetFromNow > 0) ?
    Array.from({length: daysToTargetFromNow + 1}, (_, i) => ({
      day: todayDay + i,
      weight: Math.max(parseFloat((latestWeight - lbsPerDay * i).toFixed(2)), parseFloat(target_weight))
    })) : []

  // Extend endDate if adjusted projection goes further
  if (adjustedProjPoints.length > 0) {
    const adjEnd = new Date(startDate.getTime() + (todayDay + daysToTargetFromNow) * 86400000)
    if (adjEnd > endDate) endDate = adjEnd
  }

  // Helper — get local YYYY-MM-DD string from a date
  const toLocalDate = (d) => d.toLocaleDateString('sv')
  const startDateStr = toLocalDate(startDate)

  // Actual weigh-in points plotted by date — use local date to avoid timezone shift
  const allActualPoints = weightLog
    .filter(e => parseFloat(e.weight) > 0)
    .map(e => {
      const localDate = toLocalDate(new Date(e.logged_at))
      // Calculate day offset by comparing local date strings
      const entryDate = new Date(localDate + 'T12:00:00')
      const startMidnight = new Date(startDateStr + 'T12:00:00')
      const day = Math.round((entryDate - startMidnight) / 86400000)
      return { day, weight: parseFloat(e.weight), id: e.id, date: new Date(e.logged_at) }
    }).filter(p => p.day >= 0)

  // Apply window filter
  const windowDays = state.chartWindow === '1W' ? 7 : state.chartWindow === '2W' ? 14 : state.chartWindow === '1M' ? 30 : state.chartWindow === '3M' ? 90 : null
  const windowStartDay = windowDays ? Math.max(0, (allActualPoints.length > 0 ? allActualPoints[allActualPoints.length-1].day : 0) - windowDays) : 0
  const actualPoints = windowDays ? allActualPoints.filter(p => p.day >= windowStartDay) : allActualPoints

  // Recalculate totalDays based on window
  const windowTotalDays = windowDays ? windowDays : totalDays
  const windowStartDate = new Date(startDate.getTime() + windowStartDay * 86400000)

  // Month/week labels for window
  const windowLabels = []
  if (windowDays && windowDays <= 14) {
    // 1W/2W — show day labels
    const step = windowDays <= 7 ? 1 : 2
    for (let d = 0; d <= windowTotalDays; d += step) {
      const labelDate = new Date(startDate.getTime() + (windowStartDay + d) * 86400000)
      windowLabels.push({ day: windowStartDay + d, label: labelDate.toLocaleDateString('en-US', {month:'short', day:'numeric'}) })
    }
  } else {
    // 1M, 3M, All — show month labels
    const cursor = new Date(windowStartDate)
    cursor.setDate(1); cursor.setMonth(cursor.getMonth() + 1)
    const windowEndDate = new Date(startDate.getTime() + (windowStartDay + windowTotalDays) * 86400000)
    while (cursor <= windowEndDate) {
      windowLabels.push({ day: Math.round((cursor - startDate) / 86400000), label: cursor.toLocaleDateString('en-US', {month:'short'}) })
      cursor.setMonth(cursor.getMonth() + 1)
    }
  }

  // SVG — Y range must always include start weight and target
  const visibleWeights = [startWeight, latestWeight, parseFloat(target_weight), ...actualPoints.map(p => p.weight)]
  const minW = Math.floor(Math.min(...visibleWeights)) - 1
  const maxW = Math.ceil(Math.max(...visibleWeights)) + 1
  const W = 320, H = 155, padL = 32, padR = 12, padT = 12, padB = 28

  // X scale based on window — map day offsets within the window
  const xScale = d => padL + (Math.min(Math.max(d - windowStartDay, 0), windowTotalDays) / windowTotalDays) * (W - padL - padR)
  const yScale = w => padT + ((maxW - w) / (maxW - minW)) * (H - padT - padB)

  const yStep = (maxW - minW) <= 10 ? 2 : 5
  const yGridLines = []
  for (let w = Math.ceil(minW / yStep) * yStep; w <= maxW; w += yStep) yGridLines.push(w)

  const mkPath = pts => pts.map((p,i) => (i===0?'M':'L') + xScale(p.day).toFixed(1) + ' ' + yScale(p.weight).toFixed(1)).join(' ')

  const projPath = projPoints.length > 1 ? mkPath(projPoints.filter((_,i)=>i%3===0||i===projPoints.length-1)) : ''
  const adjProjPath = adjustedProjPoints.length > 1 ? mkPath(adjustedProjPoints.filter((_,i)=>i%3===0||i===adjustedProjPoints.length-1)) : ''
  const actualPath = actualPoints.length > 1 ? mkPath(actualPoints) : ''

  // Nudge message — compare adjusted end date vs original
  if (projection && adjustedProjPoints.length > 0 && latestWeight !== startWeight) {
    const origEndDay = projection.days
    const adjEndDay = todayDay + daysToTargetFromNow
    const diffDays = origEndDay - adjEndDay
    const diffWeeks = Math.round(Math.abs(diffDays) / 7)
    if (diffDays > 14) { nudgeMsg = '🎉 ' + diffWeeks + 'w ahead of plan!'; nudgeColor = 'var(--accent)' }
    else if (diffDays > 0) { nudgeMsg = '✅ Slightly ahead of plan!'; nudgeColor = 'var(--forest2)' }
    else if (diffDays < -14) { nudgeMsg = '💪 ' + diffWeeks + 'w behind plan — keep at it.'; nudgeColor = 'var(--terra)' }
    else if (diffDays < 0) { nudgeMsg = '📊 Slightly behind plan — keep going!'; nudgeColor = 'var(--gold)' }
    else { nudgeMsg = '🎯 Right on track!'; nudgeColor = 'var(--accent)' }
  }

  // Start dot (at startWeight on startDate)
  const startDotY = yScale(startWeight)
  const startDotX = xScale(0)

  return '<div style="margin-top:16px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">&#9878; Weight Progress</div>' +
      '<div style="display:flex;gap:3px">' +
        ['1W','2W','1M','3M','All'].map(w =>
          '<button class="chart-window-btn" data-window="' + w + '" style="font-size:11px;padding:3px 8px;border-radius:5px;border:1.5px solid ' + (state.chartWindow===w?'var(--accent)':'var(--border)') + ';background:' + (state.chartWindow===w?'var(--accent)':'white') + ';color:' + (state.chartWindow===w?'white':'var(--ink3)') + ';cursor:pointer;font-family:inherit">' + w + '</button>'
        ).join('') +
      '</div>' +
    '</div>' +
    '<div style="background:white;border:1.5px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px">' +

      // Stats: Start · Current · Lost · To go · Target
      '<div style="display:flex;justify-content:space-between;margin-bottom:12px">' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--text-3)">' + startWeight + '</div><div style="font-size:10px;color:var(--text-3)">Start</div></div>' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--accent)">' + latestWeight + '</div><div style="font-size:10px;color:var(--text-3)">Current</div></div>' +
        (lostSoFar > 0.1 ? '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--accent)">-' + lostSoFar.toFixed(1) + '</div><div style="font-size:10px;color:var(--text-3)">Lost</div></div>' : '') +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--text-2)">' + toGo.toFixed(1) + '</div><div style="font-size:10px;color:var(--text-3)">To go</div></div>' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--terra)">' + target_weight + '</div><div style="font-size:10px;color:var(--text-3)">Target</div></div>' +
      '</div>' +

      // SVG Graph
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' +

        // Grid lines + Y labels
        yGridLines.map(w =>
          '<line x1="' + padL + '" y1="' + yScale(w).toFixed(1) + '" x2="' + (W-padR) + '" y2="' + yScale(w).toFixed(1) + '" stroke="var(--cream3)" stroke-width="1"/>' +
          '<text x="' + (padL-4) + '" y="' + (yScale(w)+3).toFixed(1) + '" text-anchor="end" font-size="7" fill="var(--ink3)">' + w + '</text>'
        ).join('') +

        // Target line
        '<line x1="' + padL + '" y1="' + yScale(parseFloat(target_weight)).toFixed(1) + '" x2="' + (W-padR) + '" y2="' + yScale(parseFloat(target_weight)).toFixed(1) + '" stroke="var(--terra)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.7"/>' +

        // Start date marker — only show on All view
        (!windowDays ? (
          '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H-padB) + '" stroke="var(--forest2)" stroke-width="1" opacity="0.4"/>' +
          '<text x="' + padL + '" y="' + (H-padB+12) + '" text-anchor="middle" font-size="8" font-weight="bold" fill="var(--forest2)">' + startDate.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + '</text>'
        ) : '') +

        // Window labels
        windowLabels.map(m =>
          '<line x1="' + xScale(m.day).toFixed(1) + '" y1="' + padT + '" x2="' + xScale(m.day).toFixed(1) + '" y2="' + (H-padB) + '" stroke="var(--cream3)" stroke-width="1" stroke-dasharray="2,3"/>' +
          '<text x="' + xScale(m.day).toFixed(1) + '" y="' + (H-padB+12) + '" text-anchor="middle" font-size="8" fill="var(--ink3)">' + m.label + '</text>'
        ).join('') +

        // Start weight dot (anchor of the projected line)
        '<circle cx="' + startDotX.toFixed(1) + '" cy="' + startDotY.toFixed(1) + '" r="4" fill="var(--ink3)" stroke="white" stroke-width="1.5"/>' +
        '<text x="' + (startDotX+7).toFixed(1) + '" y="' + (startDotY-5).toFixed(1) + '" font-size="8" font-weight="bold" fill="var(--ink3)">' + startWeight + '</text>' +

        // Plan line (solid grey — the ideal straight path from start to goal)
        // Original projection line (darker grey dashed, more visible)
        (projPath ? '<path d="' + projPath + '" fill="none" stroke="#999" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.9"/>' : '') +
        // Adjusted projection from current weight — same rate, new starting point (green dashed)
        (adjProjPath ? '<path d="' + adjProjPath + '" fill="none" stroke="var(--forest2)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.85"/>' : '') +

        // Actual trajectory forward (colored dashed — extrapolated from your actual pace)

        // Actual logged weights (dotted green — your real journey connecting weigh-ins)
        (actualPath ? '<path d="' + actualPath + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4,3" stroke-linejoin="round"/>' : '') +

        // Actual dots with date labels
        actualPoints.map((p, i) => {
          const cx = xScale(p.day), cy = yScale(p.weight)
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
          const dateLabel = p.date.toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone: tz})
          const labelX = cx > W - 50 ? cx - 6 : cx + 6
          const anchor = cx > W - 50 ? 'end' : 'start'
          const labelY = cy > H - padB - 20 ? cy - 10 : cy + 14
          const isLatest = i === actualPoints.length - 1
          return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (isLatest ? 4.5 : 3.5) + '" fill="var(--accent)" stroke="white" stroke-width="1.5"/>' +
            '<text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="' + anchor + '" font-size="7" fill="var(--ink3)">' + dateLabel + '</text>' +
            (isLatest ? '<text x="' + (cx > W-60 ? cx-6 : cx+6).toFixed(1) + '" y="' + (cy-7).toFixed(1) + '" text-anchor="' + (cx>W-60?'end':'start') + '" font-size="8" font-weight="bold" fill="var(--accent)">' + p.weight + '</text>' : '')
        }).join('') +

      '</svg>' +

      // Dates line
      (projection ? '<div style="font-size:11px;color:var(--text-3);margin-top:4px;text-align:center">Original: <strong>' + projection.date + '</strong>' +
        (adjProjPath && daysToTargetFromNow > 0 ? ' &nbsp;·&nbsp; Updated: <strong style="color:var(--accent)">' + new Date(startDate.getTime() + (todayDay + daysToTargetFromNow) * 86400000).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) + '</strong>' : '') +
      '</div>' : '') +

      // Nudge
      (nudgeMsg ? '<div style="font-size:12px;font-weight:600;color:' + nudgeColor + ';margin-top:8px;text-align:center;padding:6px 10px;background:var(--gray-100);border-radius:8px">' + nudgeMsg + '</div>' : '') +

      // Legend
      '<div style="display:flex;gap:12px;justify-content:center;margin-top:8px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4,3"/></svg>Your weigh-ins</div>' +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--ink4)" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.6"/></svg>Original plan</div>' +
        (adjProjPath ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--forest2)" stroke-width="1.5" stroke-dasharray="4,3"/></svg>Updated plan</div>' : '') +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--terra)" stroke-width="1.5" stroke-dasharray="4,3"/></svg>Target</div>' +
      '</div>' +

    '</div>' +

    // Recent weigh-ins list
    (weightLog.length > 0 ?
      '<div style="margin-top:8px">' +
        weightLog.slice().reverse().slice(0, 5).map(e =>
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--cream2)">' +
            '<span style="font-size:13px;font-weight:600">' + e.weight + ' lbs</span>' +
            '<span style="font-size:11px;color:var(--text-3)">' + new Date(e.logged_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}) + '</span>' +
            '<button class="remove-btn" data-weight-del="' + e.id + '">x</button>' +
          '</div>'
        ).join('') +
      '</div>'
    : '<div style="font-size:12px;color:var(--text-4);padding:4px 0">Log your first weigh-in to start tracking!</div>') +

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

function isDateToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0,10)
}

function getMealPlanEntries(date, slot) {
  return state.mealPlan.filter(e => e.date === date && e.meal_slot === slot)
}

function renderTonightCard() {
  const today = new Date().toISOString().slice(0,10)
  // Prefer Dinner, fall back to Lunch
  let entries = getMealPlanEntries(today, 'Dinner')
  let slotLabel = 'Dinner'
  if (!entries.length) {
    entries = getMealPlanEntries(today, 'Lunch')
    slotLabel = 'Lunch'
  }

  if (!entries.length) {
    // Empty state
    return '<div style="border:1.5px dashed var(--border-strong);border-radius:12px;padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:var(--gray-100);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">🍽</div>' +
      '<div>' +
        '<div style="font-size:13px;color:var(--text-2)">Nothing planned for tonight.</div>' +
        '<div class="tonight-plan-nav" style="font-size:12px;font-weight:700;color:var(--black);margin-top:2px;cursor:pointer">Plan dinner →</div>' +
      '</div>' +
    '</div>'
  }

  // Get recipe names
  const recipeNames = entries.map(e => {
    const r = state.recipes.find(x => x.id === e.recipe_id)
    return r ? r.name : e.recipe_name || 'Recipe'
  })

  const nameDisplay = recipeNames.length === 1
    ? recipeNames[0]
    : recipeNames.join(' · ')

  // For cook now — if single recipe go to cook mode, if multiple open game plan
  const isSingle = entries.length === 1
  const singleId = isSingle ? entries[0].recipe_id : null

  return '<div style="background:#1a1a1a;border-radius:14px;padding:16px;margin-bottom:14px">' +
    '<div style="font-size:10px;font-weight:700;letter-spacing:0.7px;color:rgba(255,255,255,0.38);text-transform:uppercase;margin-bottom:6px">Tonight&#39;s plan · ' + slotLabel + '</div>' +
    '<div style="font-size:17px;font-weight:700;color:#fff;margin-bottom:3px;letter-spacing:-0.3px;line-height:1.3">' + esc(nameDisplay) + '</div>' +
    '<div style="font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:14px">' + entries.length + ' recipe' + (entries.length>1?'s':'') + ' planned</div>' +
    (isSingle
      ? '<button class="ra-btn" data-cook-mode="' + singleId + '" style="background:var(--accent);color:white;border-color:var(--accent);font-size:12px;font-weight:600;padding:7px 16px;border-radius:8px">Cook now</button>'
      : '<button class="tonight-plan-btn" data-tonight-slot="' + slotLabel + '" style="background:var(--accent);color:white;border:none;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Game Plan →</button>') +
  '</div>'
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

function renderCalendarRecipePreviewModal() {
  const r = state.recipes.find(r => r.id === state.calendarRecipePreview)
  if (!r) return ''
  // Temporarily expand the recipe so renderRecipeCard shows full detail
  const prev = state.expandedRecipe
  state.expandedRecipe = r.id
  const cardHtml = renderRecipeCard(r)
  state.expandedRecipe = prev
  return '<div class="modal-bg" id="cal-recipe-preview-bg" style="z-index:200;align-items:flex-end">' +
    '<div class="modal-sheet" style="max-height:88vh;overflow-y:auto;border-radius:20px 20px 0 0;padding:0">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:1">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text-2)">Recipe</div>' +
        '<button id="cal-recipe-preview-close" style="background:none;border:none;font-size:20px;color:var(--text-3);cursor:pointer;line-height:1;padding:0">&times;</button>' +
      '</div>' +
      '<div style="padding:0 4px 20px">' + cardHtml + '</div>' +
    '</div>' +
  '</div>'
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
    const today = isDateToday(date)
    const dateMeals = state.mealPlan.filter(e => e.date === date && e.recipe_id)
    html += '<div class="cal-day ' + (today ? 'cal-day-today' : '') + '">'
    html += '<div class="cal-day-header">'
    html += '<span class="cal-day-name">' + DAY_NAMES[idx] + '</span>'
    html += '<span class="cal-day-date">' + formatDate(date).split(', ')[1] + '</span>'
    if (dateMeals.length > 0) {
      const dinnerDefault = localStorage.getItem('mep_dinner_time') || '7:00 PM'
      html += '<button class="cal-game-plan-btn" data-game-plan-slot="Day" data-game-plan-date="' + date + '" data-game-plan-rid="" data-game-plan-time="' + esc(dinnerDefault) + '" style="margin-left:auto;font-size:10px;padding:3px 9px;background:var(--black);color:white;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">📋 Plan Day</button>'
    }
    html += '</div>'

    MEAL_SLOTS.forEach(slot => {
      const entries = getMealPlanEntries(date, slot)
      const slotHasRecipe = entries.some(e => e.recipe_id)
      html += '<div class="cal-slot">'
      html += '<div class="cal-slot-label" style="display:flex;align-items:center;justify-content:space-between">'
      html += '<span>' + slot + '</span>'
      if (slotHasRecipe) {
        const defaultTime = slot === 'Breakfast' ? '8:00 AM' : slot === 'Lunch' ? '12:30 PM' : slot === 'Snack' ? '3:30 PM' : (localStorage.getItem('mep_dinner_time') || '7:00 PM')
        html += '<button class="cal-game-plan-btn" data-game-plan-slot="' + slot + '" data-game-plan-date="' + date + '" data-game-plan-rid="" data-game-plan-time="' + esc(defaultTime) + '" style="font-size:10px;padding:2px 7px;background:var(--black);color:white;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">📋 Plan</button>'
      }
      html += '</div>'

      entries.forEach(entry => {
        html += '<div class="cal-entry">'
        html += (entry.recipe_id
          ? '<button class="cal-entry-name" data-go-recipe="' + entry.recipe_id + '" style="background:none;border:none;cursor:pointer;text-align:left;font-family:inherit;color:var(--accent);font-weight:600;font-size:13px;padding:0;text-decoration:underline dotted">' + esc(entry.recipe_name || 'Unnamed') + '</button>'
          : '<span class="cal-entry-name">' + esc(entry.recipe_name || 'Unnamed') + '</span>')
        html += '<div class="cal-entry-actions">'
        html += '<button class="cal-entry-log" data-log-plan="' + entry.id + '" data-plan-name="' + esc(entry.recipe_name) + '" data-plan-rid="' + (entry.recipe_id||'') + '">+ Log</button>'
        if (entry.recipe_id) html += '<button class="cal-entry-log" data-shop-plan="' + entry.recipe_id + '" style="background:var(--accent-light);color:var(--accent)">+ List</button>'
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

    // Manual entry first
    html += '<div style="display:flex;gap:7px;margin-bottom:14px">'
    html += '<input id="cal-manual-input" placeholder="e.g. Leftovers, Protein bar..." style="flex:1;padding:9px 12px;border:1.5px solid var(--border);border-radius:12px;font-size:13px;font-family:inherit" />'
    html += '<button class="add-btn" id="cal-manual-add">Add</button>'
    html += '</div>'

    // Then recipe search
    html += '<div style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Or search recipes</div>'
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
  const search = (state.tagSearch || '').toLowerCase()
  const recipeTags = getTagsForNamespace('recipe').filter(t => !search || t.name.toLowerCase().includes(search))
    .slice().sort((a, b) => a.name.localeCompare(b.name))
  const locationTags = getTagsForNamespace('location').filter(t => !search || t.name.toLowerCase().includes(search))
    .slice().sort((a, b) => a.name.localeCompare(b.name))

  const categoryTags = recipeTags.filter(t => !t.tag_type || t.tag_type === 'category')
  const styleTags = recipeTags.filter(t => t.tag_type === 'style')
  const hasTyped = recipeTags.some(t => t.tag_type === 'style')

  const renderChip = (t, ns) =>
    '<span class="tag-library-chip" style="display:inline-flex;align-items:center;gap:4px;margin:3px">' +
      esc(t.name) +
      '<button class="tag-lib-del" data-del-tag-id="' + t.id + '" data-del-tag-ns="' + ns + '" style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-3);padding:0;line-height:1">×</button>' +
    '</span>'

  const renderSection = (title, hint, tags, ns, addId, tagType) =>
    '<div class="tags-section">' +
      '<div class="tags-section-title">' + title + '</div>' +
      '<div class="tags-section-hint" style="font-size:11px;color:var(--text-3);margin-bottom:8px">' + hint + '</div>' +
      '<div class="tags-section-chips" style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:8px">' +
        (tags.length ? tags.map(t => renderChip(t, ns)).join('') : '<span style="font-size:12px;color:var(--text-4);font-style:italic">None yet</span>') +
      '</div>' +
      '<div class="tag-add-row" style="display:flex;gap:6px">' +
        '<input class="tag-lib-input" id="' + addId + '" placeholder="Add tag..." style="flex:1;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit" />' +
        '<button class="add-btn" data-add-lib-tag="' + ns + '" data-tag-type="' + tagType + '" data-input-id="' + addId + '">+ Add</button>' +
      '</div>' +
    '</div>'

  return '<div class="tab-content">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
      '<div class="section-title">Tag Library</div>' +
      '<button class="add-btn" id="organize-tags-btn" style="background:var(--accent-light);color:var(--accent);border:1.5px solid var(--forest2);font-size:12px">' +
        (hasTyped ? '✦ Re-organize' : '✦ Auto-organize') +
      '</button>' +
    '</div>' +
    renderSearchBar('tag-search', state.tagSearch || '', 'Search tags...') +

    // Recipe tags — split into Category and Style if typed, flat if not
    '<div style="background:var(--gray-100);border-radius:12px;padding:12px 14px;margin-bottom:14px">' +
      '<div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:2px">🥘 Recipe Tags</div>' +
      (hasTyped ? (
        renderSection('Category', 'What the dish IS — protein, cuisine, main ingredient (Pork, Pasta, Salad)', categoryTags, 'recipe', 'new-lib-tag-recipe-category', 'category') +
        renderSection('Style', 'How it\'s made or when — method, occasion (Sous Vide, Weeknight, Party)', styleTags, 'recipe', 'new-lib-tag-recipe-style', 'style')
      ) : (
        '<div style="font-size:12px;color:var(--text-3);margin-bottom:10px">Tap <strong>✦ Auto-organize</strong> to split into Category and Style for better filtering.</div>' +
        renderSection('All Recipe Tags', 'Meal type, occasion, cooking method, main ingredient', recipeTags, 'recipe', 'new-lib-tag-recipe', 'category')
      )) +
    '</div>' +

    // Location tags
    '<div style="background:var(--gray-100);border-radius:12px;padding:12px 14px">' +
      '<div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:2px">🛒 Pantry & Store Tags</div>' +
      renderSection('Location Tags', 'Store aisle, fridge section, pantry shelf', locationTags, 'location', 'new-lib-tag-location', 'category') +
    '</div>' +
  '</div>'
}

// Replace recipe names in AI text with tappable links
function linkifyRecipes(text) {
  // Sort recipes longest-name-first so "Lemon Herb Chicken Soup" matches before "Lemon Herb Chicken"
  const sorted = [...state.recipes].sort((a, b) => b.name.length - a.name.length)
  // Escape the text first, then inject spans (safe — we're working on already-escaped HTML)
  let html = esc(text)
  sorted.forEach(r => {
    const escapedName = esc(r.name)
    const re = new RegExp('(?<![\\w-])' + escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'g')
    html = html.replace(re,
      '<button class="chat-recipe-link" data-go-recipe="' + r.id + '" style="background:none;border:none;padding:0;color:var(--accent);font-weight:700;text-decoration:underline dotted;cursor:pointer;font-family:inherit;font-size:inherit">' + escapedName + '</button>'
    )
  })
  // Linkify time references
  html = linkifyTimers(html)
  // Convert newlines to <br> for display
  html = html.replace(/\n/g, '<br>')
  return html
}

function renderChat() {
  const ctx = state.chatRecipeContext
  // Use per-recipe thread if a recipe is focused, otherwise main chat
  const messages = ctx ? (state.recipeChatMessages[ctx.id] || []) : state.chatMessages

  const chatHtml = messages.length === 0
    ? (ctx
        ? '<div class="chat-empty"><div class="chat-empty-title">' + esc(ctx.name) + '</div><div class="chat-empty-sub">Ask anything about this recipe — substitutions, technique, timing, scaling.</div></div>'
        : '<div class="chat-empty"><div class="chat-empty-title">Your AI Food Coach</div><div class="chat-empty-sub">Ask about meal planning, recipes, calories, shopping — anything food related. I know your recipes, pantry and eating patterns.</div><div class="chat-empty-prompts">' +
          ['Plan my week', 'What should I eat today?', 'What can I make with my pantry?', 'How am I doing with my goals?'].map(p =>
            '<button class="chat-starter" data-prompt-text="' + esc(p) + '">' + esc(p) + '</button>'
          ).join('') +
          '</div></div>')
    : messages.map(m =>
        '<div class="chat-msg chat-msg-' + m.role + '">' +
          '<div class="chat-bubble">' + (m.role === 'assistant' ? linkifyRecipes(m.content) : esc(m.content)) + '</div>' +
        '</div>'
      ).join('')

  return '<div class="chat-fullpage">' +
    // Recipe context banner
    (ctx ? (
      '<div style="background:var(--accent-light);border-bottom:1.5px solid var(--forest2);padding:8px 14px;display:flex;justify-content:space-between;align-items:center">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<button id="chat-back-to-recipe" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--accent);padding:0;line-height:1;font-family:inherit" title="Back to recipe">←</button>' +
          '<div>' +
            '<div style="font-size:10px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Asking about</div>' +
            '<button id="chat-go-to-recipe" style="background:none;border:none;padding:0;cursor:pointer;font-size:13px;font-weight:700;color:var(--accent);text-decoration:underline dotted;font-family:inherit;text-align:left">' + esc(ctx.name) + '</button>' +
          '</div>' +
        '</div>' +
        '<button id="chat-clear-context" style="font-size:11px;color:var(--text-3);background:none;border:1px solid var(--border);border-radius:6px;padding:2px 8px;cursor:pointer">✕ Clear</button>' +
      '</div>'
    ) : '') +
    '<div class="chat-messages" id="chat-messages">' + chatHtml + '</div>' +
    (state.chatLoading ? '<div class="chat-loading"><div class="chat-dots"><span></span><span></span><span></span></div></div>' : '') +
    (messages.length > 0 ? '<button class="chat-clear-btn" id="chat-clear">Clear conversation</button>' : '') +
    '<div class="chat-input-row">' +
      '<input id="chat-input" class="chat-input" placeholder="' + (ctx ? 'Ask about ' + esc(ctx.name) + '...' : 'Message your food coach...') + '" />' +
      '<button class="chat-send-btn" id="chat-send" ' + (state.chatLoading ? 'disabled' : '') + '>&#9654;</button>' +
    '</div>' +
  '</div>'
}


async function generateGamePlan(slot, targetTime, date, recipeId, notes) {
  const isWholeDay = slot === 'Day'

  // Helper — build full recipe detail, trimming will happen at the end if needed
  const recipeDetail = (entry, recipe) => {
    const instructions = recipe?.instructions || ''
    return '=== ' + (entry.meal_slot ? entry.meal_slot + ': ' : '') + entry.recipe_name + ' ===\n' +
      (recipe?.ingredients ? 'Ingredients:\n' + recipe.ingredients + '\n' : '') +
      (instructions ? 'Instructions:\n' + instructions : '')
  }

  let mealText = ''

  if (isWholeDay) {
    const allEntries = state.mealPlan.filter(e => e.date === date && e.recipe_id)
    const details = allEntries.map(entry => {
      const recipe = state.recipes.find(r => String(r.id) === String(entry.recipe_id))
      return recipeDetail(entry, recipe)
    })
    mealText = details.join('\n\n')
  } else {
    const slotEntries = state.mealPlan.filter(e => e.date === date && e.meal_slot === slot && e.recipe_id)
    const details = slotEntries.map(entry => {
      const recipe = state.recipes.find(r => String(r.id) === String(entry.recipe_id))
      return recipeDetail(entry, recipe)
    })
    mealText = details.join('\n\n')
  }

  // Safety cap — if total is very large, trim each recipe's instructions proportionally
  if (mealText.length > 6000) {
    const entries = isWholeDay
      ? state.mealPlan.filter(e => e.date === date && e.recipe_id)
      : state.mealPlan.filter(e => e.date === date && e.meal_slot === slot && e.recipe_id)
    const budget = Math.floor(5000 / Math.max(entries.length, 1))
    mealText = entries.map(entry => {
      const recipe = state.recipes.find(r => String(r.id) === String(entry.recipe_id))
      const instructions = recipe?.instructions || ''
      const trimmed = instructions.length > budget ? instructions.slice(0, budget) + '\n...(trimmed)' : instructions
      return '=== ' + (entry.meal_slot ? entry.meal_slot + ': ' : '') + entry.recipe_name + ' ===\n' +
        (recipe?.ingredients ? 'Ingredients:\n' + recipe.ingredients + '\n' : '') +
        (trimmed ? 'Instructions:\n' + trimmed : '')
    }).join('\n\n')
  }

  const now = new Date()
  const currentTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  const mealDate = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'today'
  const isToday = date === new Date().toISOString().slice(0, 10)

  const recipeNames = (mealText.match(/=== (.+?) ===/g) || []).map(m => m.replace(/===/g, '').trim())
  const slotLabel = isWholeDay ? 'the whole day' : slot
  const prompt = `You are a professional chef planning a dinner cooking session. Your job is to output ONE unified list of steps that intelligently interleaves ALL recipes so everything is ready at ${targetTime}.

DINNER: ${mealDate} at ${targetTime}
RECIPES BEING MADE: ${recipeNames.join(', ')}
${notes ? 'NOTES: ' + notes : ''}

FULL RECIPE DETAILS:
${mealText}

INSTRUCTIONS:
Think like a chef coordinating a kitchen. Plan the entire cooking session as one sequence — not recipe by recipe. Use passive time (oven, simmering, resting) from one dish to do active prep on another.

For example with steak + potatoes + salad:
1. Start oven (passive time → use it to prep everything)
2. Make salad dressing while oven heats
3. Sear steak (passive sear time → prep potatoes)
4. Put potatoes in steak pan, oven
5. Rest steak while potatoes finish
6. Plate together

Return ONLY a JSON array of steps with timing:
[
  {"step": "Preheat oven to 375°F", "active_min": 1, "passive_min": 18},
  {"step": "Make Café de Paris dressing — combine anchovies, capers, shallots...", "active_min": 8, "passive_min": 0},
  {"step": "Sear Denver steak — season, sear in 2 tbsp butter + 2 tbsp olive oil, 2 min per side", "active_min": 6, "passive_min": 0},
  {"step": "While steak rests, add potatoes cut-side down to same pan, oven 375°F", "active_min": 3, "passive_min": 20},
  {"step": "Flash steak in oven 2-3 min, then slice", "active_min": 4, "passive_min": 0},
  {"step": "Assemble salad, plate everything together", "active_min": 4, "passive_min": 0}
]

Rules:
- Include exact quantities inline with every step
- Label which recipe each step is for if not obvious ("For the pasta:" or "For the steak:")
- Use passive time aggressively — nothing sits idle if another recipe needs attention
- ALL recipes must be ready by ${targetTime}
- No markdown, no backticks, ONLY the JSON array\``

  try {
    let resp, attempts = 0
    while (attempts < 3) {
      resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }]
        })
      })
      if (resp.ok) break
      if (resp.status === 429 || resp.status === 529) {
        await new Promise(r => setTimeout(r, 2000 * (attempts + 1)))
        attempts++
        continue
      }
      break
    }
    const data = await resp.json()
    if (!resp.ok) {
      console.error('Game plan API error:', resp.status, data)
      return null
    }
    const text = data.content?.[0]?.text?.trim() || ''
    console.log('Game plan raw response:', text.slice(0, 300))
    const clean = text.replace(/^```json\n?|^```\n?|```$/gm, '').trim()
    const arrayMatch = clean.match(/\[[\s\S]*\]/)
    if (!arrayMatch) {
      console.error('No JSON array found in response:', clean.slice(0, 200))
      return null
    }
    const steps = JSON.parse(arrayMatch[0])

    // Calculate times ourselves working BACKWARD from targetTime
    const parseTime = (t) => {
      const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i)
      if (!m) return 0
      let h = parseInt(m[1]), min = parseInt(m[2]), ampm = m[3].toUpperCase()
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      return h * 60 + min
    }
    const formatTime = (totalMins) => {
      const h = Math.floor(((totalMins % (24*60)) + 24*60) % (24*60) / 60)
      const m = ((totalMins % 60) + 60) % 60
      const ampm = h >= 12 ? 'PM' : 'AM'
      const hour = h % 12 || 12
      return hour + ':' + String(m).padStart(2, '0') + ' ' + ampm
    }

    // Work backward: dinner time minus total duration of each step from the end
    const dinnerMins = parseTime(targetTime)
    const now = new Date()
    const nowMins = now.getHours() * 60 + now.getMinutes()
    const isTodayMeal = date === now.toISOString().slice(0, 10)

    // Calculate cumulative time from end, assign start times
    const result = []
    let cursor = dinnerMins

    // Process steps in reverse to assign times backward from dinner
    const reversed = [...steps].reverse()
    for (const s of reversed) {
      const total = (s.active_min || 0) + (s.passive_min || 0)
      cursor -= total
      // Show actual time — label as "Start now" if it's already past for today's meal
      const isPast = isTodayMeal && cursor < nowMins
      result.unshift({
        time: isPast ? 'Now' : formatTime(cursor),
        step: s.step
      })
    }

    // Add serving step at dinner time
    result.push({ time: targetTime, step: (isWholeDay ? 'Dinner' : slot) + ' is served 🍽️' })

    return result
  } catch(e) {
    console.error('Game plan error:', e)
    return null
  }
}

function renderTagOrganizerModal() {
  const m = state.tagOrganizerModal
  if (!m) return ''
  if (m.loading) {
    return '<div class="modal-bg" id="tag-organizer-bg">' +
      '<div class="modal-sheet">' +
        '<div class="modal-title">🏷 Organize Tags</div>' +
        '<div style="text-align:center;padding:30px 0;color:var(--text-3)">Asking AI to sort your tags...</div>' +
      '</div>' +
    '</div>'
  }
  const tags = m.tags || []
  const renderTagRow = (t) => {
    const type = t.tag_type || 'category'
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--cream3)">' +
      '<div style="flex:1;font-size:13px;font-weight:600;color:var(--text)">' + esc(t.name) + '</div>' +
      '<div style="display:flex;gap:4px">' +
        '<button class="tag-type-btn ' + (type === 'category' ? 'active' : '') + '" data-tag-id="' + t.id + '" data-tag-type="category" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1.5px solid ' + (type==='category'?'var(--accent)':'var(--border)') + ';background:' + (type==='category'?'var(--accent)':'white') + ';color:' + (type==='category'?'white':'var(--ink3)') + ';cursor:pointer;font-family:inherit">Category</button>' +
        '<button class="tag-type-btn ' + (type === 'style' ? 'active' : '') + '" data-tag-id="' + t.id + '" data-tag-type="style" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1.5px solid ' + (type==='style'?'var(--accent)':'var(--border)') + ';background:' + (type==='style'?'var(--accent)':'white') + ';color:' + (type==='style'?'white':'var(--ink3)') + ';cursor:pointer;font-family:inherit">Style</button>' +
      '</div>' +
    '</div>'
  }
  return '<div class="modal-bg" id="tag-organizer-bg">' +
    '<div class="modal-sheet" style="max-height:85vh;overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<div class="modal-title" style="margin:0">🏷 Organize Tags</div>' +
        '<button id="tag-organizer-close" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-3);padding:0;line-height:1">×</button>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-bottom:14px">Category = what the dish is (Pork, Pasta). Style = how it\'s made (Sous Vide, Weeknight). Filtering uses Category as OR, then Style to narrow.</div>' +
      tags.sort((a, b) => a.name.localeCompare(b.name)).map(renderTagRow).join('') +
      '<div style="margin-top:16px">' +
        '<button class="modal-save" id="tag-organizer-save" style="width:100%">Save</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

function renderCookModeInline(r) {
  const { tab, scaledIngredients, scaleLabel, checkedIngredients, stepAmounts, stepAmountsLoading, editing } = state.cookMode || {}
  const activeTab = tab || 'ingredients'
  const isEditing = editing || false

  const ingredientSource = scaledIngredients || r.ingredients || ''
  const ingredients = ingredientSource.split('\n').map(l => l.trim()).filter(Boolean)
  const rawInstructions = r.instructions || r.text || ''

  const steps = rawInstructions
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^(step\s*\d+[.:]?\s*|\d+\.\s*)/i, ''))
    .filter(l => l.length > 4)

  const getChipsForStep = (stepIdx) => {
    if (!stepAmounts) return []
    return stepAmounts[stepIdx + 1] || []
  }

  const tabBtn = (tabId, label) =>
    '<button id="cook-tab-' + tabId + '" style="flex:1;padding:10px;font-size:13px;font-weight:' +
    (activeTab===tabId?'700':'500') + ';color:' + (activeTab===tabId?'var(--accent)':'var(--text-3)') +
    ';background:none;border:none;border-bottom:2px solid ' + (activeTab===tabId?'var(--accent)':'transparent') +
    ';cursor:pointer;font-family:inherit">' + label + '</button>'

  const checkedSet = checkedIngredients || new Set()

  // ── INGREDIENTS TAB ──
  const scaleRow = '<div style="display:flex;gap:6px;padding:8px 0 6px;align-items:center">' +
    '<span style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0">Scale</span>' +
    ['½x','1x','2x','3x'].map(s => {
      const isActive = (s === '1x' && !scaledIngredients) || scaleLabel === s
      return '<button class="scale-btn" data-scale="' + s + '" data-recipe-id="' + r.id + '" style="' + (isActive?'background:var(--black);color:white;border-color:var(--black);':'') + '">' + s + '</button>'
    }).join('') +
  '</div>'

  const ingredientsView = isEditing
    ? '<div style="padding-top:8px">' +
        '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Recipe name</div>' +
        '<input id="cook-edit-name" value="' + esc(r.name) + '" style="width:100%;padding:9px 12px;border:1.5px solid var(--border-strong);border-radius:8px;font-size:14px;font-family:inherit;font-weight:600;background:var(--gray-50);color:var(--text);outline:none;margin-bottom:12px" />' +
        '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Ingredients</div>' +
        '<textarea id="cook-edit-ingredients" style="width:100%;min-height:180px;padding:10px 12px;border:1.5px solid var(--border-strong);border-radius:8px;font-size:14px;font-family:inherit;line-height:1.6;background:var(--gray-50);color:var(--text);outline:none;resize:vertical">' + esc(r.ingredients || '') + '</textarea>' +
        '<button id="cook-edit-save" style="margin-top:10px;width:100%;padding:11px;background:var(--black);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Save changes</button>' +
      '</div>'
    : scaleRow + (ingredients.length > 0
        ? ingredients.map((line, i) => {
            const isChecked = checkedSet.has(i)
            return '<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:0.5px solid var(--border);cursor:pointer" class="cook-ing-row" data-ing-idx="' + i + '">' +
              '<div style="width:6px;height:6px;border-radius:50%;background:' + (isChecked?'var(--border-strong)':'var(--accent)') + ';margin-top:8px;flex-shrink:0"></div>' +
              '<div style="font-size:15px;line-height:1.4;color:' + (isChecked?'var(--text-4)':'var(--text)') + ';' + (isChecked?'text-decoration:line-through;':'') + '">' + linkifyTimers(esc(line)) + '</div>' +
            '</div>'
          }).join('')
        : '<div style="color:var(--text-4);font-style:italic;padding:16px 0">No ingredients yet — tap Edit to add</div>')

  // ── INSTRUCTIONS TAB ──
  const amountsLoading = stepAmountsLoading
    ? '<div style="font-size:12px;color:var(--text-3);padding:6px 0 2px;font-style:italic">Loading ingredient amounts...</div>'
    : ''

  const instructionsView = isEditing
    ? '<div style="padding-top:8px">' +
        '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Instructions</div>' +
        '<textarea id="cook-edit-instructions" style="width:100%;min-height:220px;padding:10px 12px;border:1.5px solid var(--border-strong);border-radius:8px;font-size:14px;font-family:inherit;line-height:1.6;background:var(--gray-50);color:var(--text);outline:none;resize:vertical">' + esc(rawInstructions) + '</textarea>' +
        '<button id="cook-edit-save" style="margin-top:10px;width:100%;padding:11px;background:var(--black);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Save changes</button>' +
      '</div>'
    : (steps.length > 0
        ? amountsLoading + steps.map((step, i) => {
            const chips = getChipsForStep(i)
            const chipsHtml = chips.length > 0
              ? '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">' +
                  chips.map(c => '<span style="font-size:11px;font-weight:500;color:var(--text-2);background:var(--gray-100);border:0.5px solid var(--border-strong);border-radius:4px;padding:3px 8px">' + esc(c) + '</span>').join('') +
                '</div>'
              : ''
            return '<div style="padding:12px 0;border-bottom:0.5px solid var(--border)">' +
              '<div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:5px">Step ' + (i+1) + '</div>' +
              '<div style="font-size:15px;line-height:1.7;color:var(--text)">' + linkifyTimers(esc(step)) + '</div>' +
              chipsHtml +
            '</div>'
          }).join('')
        : (rawInstructions
            ? amountsLoading + '<div style="font-size:15px;line-height:1.8;color:var(--text);padding:12px 0">' + linkifyTimers(esc(rawInstructions)) + '</div>'
            : '<div style="color:var(--text-4);font-style:italic;padding:16px 0">No instructions yet — tap Edit to add</div>'))

  // ── NOTES TAB ──
  const notesView = isEditing
    ? '<div style="padding-top:8px">' +
        '<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">My cooking notes</div>' +
        '<textarea id="cook-edit-notes" placeholder="What worked, substitutions, tips..." style="width:100%;min-height:160px;padding:10px 12px;border:1.5px solid var(--border-strong);border-radius:8px;font-size:14px;font-family:inherit;line-height:1.6;background:var(--gray-50);color:var(--text);outline:none;resize:vertical">' + esc(r.cookingNotes || '') + '</textarea>' +
        '<button id="cook-edit-save" style="margin-top:10px;width:100%;padding:11px;background:var(--black);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Save notes</button>' +
      '</div>'
    : (r.cookingNotes
        ? '<div style="padding:12px 0;font-size:15px;line-height:1.7;color:var(--text-2);white-space:pre-wrap">' + esc(r.cookingNotes) + '</div>'
        : '<div style="color:var(--text-4);font-style:italic;padding:16px 0">No notes yet — tap Edit to add</div>')

  const content =
    activeTab === 'ingredients' ? ingredientsView :
    activeTab === 'instructions' ? instructionsView :
    notesView

  return '<div style="border-top:0.5px solid var(--border)">' +

    // Black header
    '<div style="background:#1a1a1a;padding:12px 14px;display:flex;align-items:center;gap:8px">' +
      '<button id="cook-mode-close" style="width:28px;height:28px;background:rgba(255,255,255,0.12);border:none;cursor:pointer;font-size:16px;color:white;line-height:1;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">×</button>' +
      '<div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:rgba(255,255,255,0.7)">Cooking</div>' +
      '<button id="cook-mode-edit-toggle" style="background:' + (isEditing?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.08)') + ';color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:4px 9px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">' + (isEditing?'Done':'Edit') + '</button>' +
      '<button class="ra-btn ra-plan" data-plan-recipe="' + r.id + '" style="background:rgba(255,255,255,0.08);color:white;border-color:rgba(255,255,255,0.25);font-size:10px;flex-shrink:0;padding:4px 8px;margin-left:2px">📋 Plan</button>' +
      '<button data-ask="' + r.id + '" style="background:rgba(255,255,255,0.08);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:4px 9px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;margin-left:2px">Ask AI</button>' +
    '</div>' +

    // Three tabs
    '<div style="display:flex;border-bottom:0.5px solid var(--border);background:var(--white)">' +
      tabBtn('ingredients', 'Ingredients') +
      tabBtn('instructions', 'Instructions') +
      tabBtn('notes', 'Notes') +
    '</div>' +

    // Content
    '<div style="padding:0 14px 16px">' + content + '</div>' +

  '</div>'
}
function gpChatKey() {
  const { date, slot } = state.gamePlanModal || {}
  return (date || 'today') + '-' + (slot || 'Dinner')
}

async function saveGamePlanToDb() {
  const { date, slot, targetTime } = state.gamePlanModal || {}
  if (!date || !slot) return
  const chatKey = gpChatKey()
  await db.saveGamePlan(
    date, slot,
    state.gamePlanResult || null,
    state.gamePlanChats[chatKey] || [],
    targetTime || null
  )
}

function renderGamePlanModal() {
  const { slot, targetTime, date } = state.gamePlanModal || {}
  const isWholeDay = slot === 'Day'
  const slotLabel = isWholeDay ? 'Whole Day' : (slot || 'Meal')
  const result = state.gamePlanResult
  const loading = state.gamePlanLoading
  const timeVal = targetTime || (slot === 'Lunch' ? '12:30 PM' : '7:00 PM')
  const view = state.gamePlanView || 'timeline'
  const chatKey = gpChatKey()
  const chatMessages = state.gamePlanChats[chatKey] || []
  const chatLoading = state.gamePlanChatLoading || false
  const dateLabel = date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'})
    : new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'})
  const hasPriorChat = chatMessages.length > 0

  const blackHeader = (title, subtitle, extra) =>
    '<div style="background:#1a1a1a;padding:14px 16px;display:flex;align-items:center;gap:10px;border-radius:20px 20px 0 0;flex-shrink:0">' +
      '<button id="gp-close" style="width:28px;height:28px;background:rgba(255,255,255,0.12);border:none;cursor:pointer;font-size:16px;color:white;line-height:1;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">×</button>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:700;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + title + '</div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:1px">' + subtitle + '</div>' +
      '</div>' +
      (extra || '') +
    '</div>'

  const sheet = (headerHtml, bodyHtml) =>
    '<div class="modal-bg" id="game-plan-bg" style="align-items:flex-end">' +
      '<div class="modal-sheet" style="max-height:90vh;display:flex;flex-direction:column;padding:0;overflow:hidden;border-radius:20px 20px 0 0">' +
        headerHtml +
        bodyHtml +
      '</div>' +
    '</div>'

  // ── CHAT VIEW ──
  if (view === 'chat') {
    const bubbles = chatMessages.map(m =>
      '<div style="display:flex;flex-direction:column;align-items:' + (m.role === 'user' ? 'flex-end' : 'flex-start') + ';margin-bottom:10px">' +
        '<div style="max-width:85%;background:' + (m.role === 'user' ? 'var(--black)' : 'var(--gray-100)') + ';color:' + (m.role === 'user' ? 'white' : 'var(--text)') + ';border-radius:14px;padding:10px 13px;font-size:13px;line-height:1.5">' +
          (m.role === 'assistant' ? linkifyTimers(esc(m.content).replace(/\n/g, '<br>')) : esc(m.content).replace(/\n/g, '<br>')) +
        '</div>' +
      '</div>'
    ).join('')

    const header = blackHeader(
      '✦ Tweak Game Plan',
      slotLabel + ' · ' + dateLabel,
      '<button id="gp-back-to-timeline" style="background:rgba(255,255,255,0.08);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:4px 9px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">← Plan</button>' +
      '<button id="gp-start-over" style="background:rgba(255,255,255,0.08);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:4px 9px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;margin-left:4px">↺ Redo</button>'
    )
    const body =
      '<div id="gp-chat-messages" style="flex:1;overflow-y:auto;padding:14px 16px;min-height:0">' +
        (chatMessages.length === 0
          ? '<div style="color:var(--text-4);font-size:13px;font-style:italic;text-align:center;padding:20px 0">What tweaks would you like to make?</div>'
          : bubbles) +
        (chatLoading ? '<div style="text-align:center;padding:10px;color:var(--text-3);font-size:13px">thinking...</div>' : '') +
      '</div>' +
      '<div style="padding:10px 14px;border-top:0.5px solid var(--border);display:flex;gap:8px;flex-shrink:0">' +
        '<input id="gp-chat-input" placeholder="e.g. I can start at 4:30pm..." style="flex:1;padding:9px 12px;border:1.5px solid var(--border-strong);border-radius:20px;font-size:13px;font-family:inherit" />' +
        '<button id="gp-chat-send" style="background:var(--black);color:white;border:none;border-radius:20px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" ' + (chatLoading ? 'disabled' : '') + '>Send</button>' +
      '</div>'
    return sheet(header, body)
  }

  // ── FULLSCREEN COOK VIEW ──
  if (view === 'fullscreen' && result) {
    return '<div style="position:fixed;inset:0;z-index:2000;background:var(--white);display:flex;flex-direction:column;font-family:inherit">' +
      '<div style="background:#1a1a1a;padding:env(safe-area-inset-top,14px) 16px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0">' +
        '<button id="gp-exit-fullscreen" style="width:28px;height:28px;background:rgba(255,255,255,0.12);border:none;cursor:pointer;font-size:16px;color:white;line-height:1;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">×</button>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:15px;font-weight:700;color:white">' + slotLabel + ' Game Plan</div>' +
          '<div style="font-size:11px;color:rgba(255,255,255,0.45)">' + dateLabel + ' · eat at ' + esc(timeVal) + '</div>' +
        '</div>' +
        '<button id="gp-tweak-from-fullscreen" style="background:rgba(255,255,255,0.08);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit">✦ Tweak</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 20px">' +
        result.map((item, i) => {
          const isLast = i === result.length - 1
          return '<div style="display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:0.5px solid var(--border)">' +
            '<div style="min-width:58px;font-size:12px;font-weight:700;color:var(--accent);padding-top:2px;flex-shrink:0">' + esc(item.time) + '</div>' +
            '<div style="font-size:15px;line-height:1.6;color:var(--text);' + (isLast ? 'font-weight:700' : '') + '">' + linkifyTimers(esc(item.step)) + '</div>' +
          '</div>'
        }).join('') +
      '</div>' +
    '</div>'
  }

  // ── FORM VIEW (no result yet) ──
  if (!result && !loading) {
    const savedNotes = state.gamePlanModal?.notes || ''
    const header = blackHeader('Game Plan', slotLabel + ' · ' + dateLabel, '')
    const body =
      '<div style="padding:16px;overflow-y:auto">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
          '<span style="font-size:13px;font-weight:600;color:var(--text-2);white-space:nowrap">Eat at</span>' +
          '<input id="gp-dinner-time" value="' + esc(timeVal) + '" placeholder="e.g. 7:00 PM" style="flex:1;padding:9px 12px;border:1.5px solid var(--accent);border-radius:10px;font-size:15px;font-family:inherit;text-align:center;font-weight:700;color:var(--accent)" />' +
        '</div>' +
        '<textarea id="gp-notes" placeholder="Anything to factor in? e.g. I can start at 4:30, already made the sauce, kids eat at 6..." style="width:100%;padding:10px 12px;border:1.5px solid var(--border-strong);border-radius:10px;font-size:13px;font-family:inherit;resize:none;min-height:80px;box-sizing:border-box;margin-bottom:14px;line-height:1.5">' + esc(savedNotes) + '</textarea>' +
        '<button id="gp-generate" style="width:100%;padding:12px;background:var(--black);color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Generate Game Plan</button>' +
      '</div>'
    return sheet(header, body)
  }

  // ── LOADING ──
  if (loading) {
    const header = blackHeader('Game Plan', slotLabel + ' · ' + dateLabel, '')
    const body =
      '<div style="padding:40px 20px;text-align:center">' +
        '<div style="font-size:24px;margin-bottom:12px">📋</div>' +
        '<div style="font-size:14px;font-weight:600;color:var(--text)">Building your timeline...</div>' +
        '<div style="font-size:12px;color:var(--text-3);margin-top:6px">Reading recipes and working backwards from ' + esc(timeVal) + '</div>' +
      '</div>'
    return sheet(header, body)
  }

  // ── RESULT VIEW ──
  const redoExtra =
    '<button id="gp-regenerate" style="background:rgba(255,255,255,0.08);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:7px;padding:4px 9px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">↺ Redo</button>'
  const header = blackHeader(slotLabel + ' Game Plan', dateLabel + ' · eat at ' + esc(timeVal), redoExtra)

  const timeline =
    '<div style="position:relative;padding-left:18px">' +
      '<div style="position:absolute;left:6px;top:8px;bottom:8px;width:2px;background:var(--accent);opacity:0.2;border-radius:2px"></div>' +
      result.map((item, i) => {
        const isLast = i === result.length - 1
        return '<div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:14px;position:relative">' +
          '<div style="position:absolute;left:-14px;top:5px;width:8px;height:8px;border-radius:50%;background:' + (isLast ? 'var(--black)' : 'var(--accent)') + ';border:2px solid white;box-shadow:0 0 0 1.5px ' + (isLast ? 'var(--black)' : 'var(--accent)') + '"></div>' +
          '<div style="min-width:58px;font-size:11px;font-weight:700;color:var(--accent);padding-top:3px;flex-shrink:0">' + esc(item.time) + '</div>' +
          '<div style="font-size:14px;color:var(--text);line-height:1.5;' + (isLast ? 'font-weight:700' : '') + '">' + linkifyTimers(esc(item.step)) + '</div>' +
        '</div>'
      }).join('') +
    '</div>'

  const actions =
    '<div style="display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:0.5px solid var(--border);margin-top:4px">' +
      '<button id="gp-start-cooking" style="width:100%;padding:12px;background:var(--black);color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">▶ Start Cooking</button>' +
      '<button id="gp-tweak" style="width:100%;padding:12px;background:var(--white);color:var(--accent);border:1.5px solid var(--accent);border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">' + (hasPriorChat ? '✦ Continue Tweaking' : '✦ Tweak with AI') + '</button>' +
    '</div>'

  const body = '<div style="padding:16px;overflow-y:auto">' + timeline + actions + '</div>'
  return sheet(header, body)
}
