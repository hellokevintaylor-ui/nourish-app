import * as db from './db.js'
import { getUserId } from './supabase.js'

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tab: localStorage.getItem('mep_tab') || 'recipes',
  recipes: [], pantry: [], shopList: [], log: [], exerciseLog: [], weightLog: [],
  goals: { calories: 2000, goal: 'maintain' },
  loading: true,
  showGoals: false,
  showSync: false,
  showHeaderMenu: false,
  showArchived: false,
  recipeView: 'cards',   // 'cards' or 'list'
  recipeSort: 'newest',  // 'newest', 'az', 'za'
  tagOrganizerModal: false,
  expandedRecipe: null,
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
  pasteModal: false,
  addRecipeModal: false,
  logModal: null,
  gamePlanModal: false,
  gamePlanResult: null,
  gamePlanLoading: false,
  gamePlanView: 'timeline',
  gamePlanChats: {},
  timerSlider: null,  // { low, high, current, label, anchorTop, anchorLeft }
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
  const [recipes, pantry, shopList, log, goals, allTags, mealPlan, historyLog, exerciseLog, weightLog, gamePlans] = await Promise.all([
    db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals(), db.fetchTags(),
    db.fetchMealPlan(weekDates[0], weekDates[6]), db.fetchFullLog(90), db.fetchExerciseLog(), db.fetchWeightLog(),
    db.fetchGamePlans()
  ])
  state.allTags = allTags || []
  state.mealPlan = mealPlan || []
  state.historyLog = historyLog || []
  state.exerciseLog = exerciseLog || []
  state.weightLog = weightLog || []
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
  // Remove any existing bar
  document.getElementById('timer-bar')?.remove()
  if (timers.length === 0) return

  const rows = timers.map(timer => {
    const mins = Math.floor(timer.remaining / 60)
    const secs = timer.remaining % 60
    const timeStr = mins + ':' + String(secs).padStart(2, '0')
    const pct = timer.totalSeconds > 0 ? (timer.remaining / timer.totalSeconds) * 100 : 0
    const isDone = timer.remaining === 0
    const barColor = isDone ? '#e05a2b' : pct < 20 ? '#e09b2b' : 'var(--forest)'

    return '<div style="padding:8px 0;border-bottom:1px solid var(--cream2)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--ink3);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(timer.label) + '</div>' +
        '<button class="timer-stop-btn" data-timer-id="' + timer.id + '" style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--ink3);padding:0;line-height:1">×</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<div style="font-size:22px;font-weight:800;color:' + barColor + ';font-variant-numeric:tabular-nums;min-width:55px">' + (isDone ? '✓ Done!' : timeStr) + '</div>' +
        '<div style="flex:1;height:4px;background:var(--cream3);border-radius:2px">' +
          '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:2px;transition:width 1s linear"></div>' +
        '</div>' +
      '</div>' +
    '</div>'
  }).join('')

  const html = '<div id="timer-bar" style="position:fixed;bottom:70px;right:18px;z-index:1000;background:white;border:2px solid var(--forest2);border-radius:14px;padding:4px 14px;box-shadow:0 4px 16px rgba(0,0,0,0.18);min-width:200px;max-width:240px;font-family:inherit">' +
    '<div style="font-size:10px;font-weight:700;color:var(--forest);text-transform:uppercase;letter-spacing:0.5px;padding:6px 0 2px">⏱ Timers</div>' +
    rows +
  '</div>'

  document.body.insertAdjacentHTML('beforeend', html)

  // Attach stop handlers
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
  // Range with dash
  const dashMatch = text.match(/(\d+)\s*[-–]\s*(\d+)\s*(min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)?/)
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
  return html.replace(/(\d+\s+to\s+\d+\s*(?:min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)?|\d+\s*[-–]\s*\d+\s*(?:min|minute|minutes|mins|hour|hr|h|sec|second|seconds|secs)?|\d+\s*(?:hour|hr|h)(?:\s+\d+\s*(?:min|minute|minutes|mins))?|\d+\s*(?:min|minute|minutes|mins|sec|second|seconds|secs))/gi, (match) => {
    const parsed = parseTimerDuration(match)
    if (!parsed) return match
    if (parsed.isRange) {
      // Range — show slider button
      return '<button class="timer-link timer-range-link" data-timer-low="' + parsed.low + '" data-timer-high="' + parsed.high + '" data-timer-label="' + esc(match.trim()) + '" style="background:var(--sage4);border:1.5px solid var(--forest2);color:var(--forest);border-radius:6px;padding:1px 6px;font-size:inherit;font-family:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:3px">⏱ ' + match.trim() + '</button>'
    }
    return '<button class="timer-link" data-timer-seconds="' + parsed.seconds + '" data-timer-label="' + esc(match.trim()) + '" style="background:var(--sage4);border:1.5px solid var(--forest2);color:var(--forest);border-radius:6px;padding:1px 6px;font-size:inherit;font-family:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:3px">⏱ ' + match.trim() + '</button>'
  })
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
          <button class="icon-btn ${state.showHeaderMenu?'active':''}" id="header-menu-btn" style="font-size:18px;padding:4px 10px;letter-spacing:1px">⋯</button>
        </div>
      </div>

      <!-- HEADER MENU DROPDOWN -->
      ${state.showHeaderMenu ? `
      <div style="background:var(--forest);padding:8px 12px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid rgba(255,255,255,0.1)">
        <button class="icon-btn" id="clip-url-btn" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2)">📎 Clip</button>
        <button class="icon-btn" id="paste-btn" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2)">📋 Paste</button>
        <button class="icon-btn" id="force-update-btn" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2)">↻ Update</button>
        <button class="icon-btn" id="sync-toggle" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2)">🔗 Sync</button>
        <button class="icon-btn ${state.showGoals?'active':''}" id="goals-toggle" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2)">⚙️ Goals</button>
      </div>` : ''}

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
          <select data-goal="activity_level" style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:var(--forest);color:white;font-size:13px">
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

      <!-- SCROLL TO TOP -->
      <button id="scroll-top-btn" style="display:none;position:fixed;bottom:24px;right:18px;z-index:999;background:var(--forest);color:white;border:none;border-radius:50px;padding:8px 14px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,0.25);align-items:center;gap:5px">&#8679; Top</button>
    </div>
  `
  bindEvents()

  // Timer slider popover
  if (state.timerSlider) {
    const { low, high, current, label, anchorTop, anchorLeft } = state.timerSlider
    const pct = ((current - low) / (high - low)) * 100
    const mins = Math.round(current / 60)
    const popover = document.createElement('div')
    popover.id = 'timer-slider-popover'
    popover.style.cssText = 'position:fixed;z-index:2000;background:white;border:2px solid var(--forest2);border-radius:14px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.2);min-width:200px;font-family:inherit'
    popover.style.top = Math.min(anchorTop + 30, window.innerHeight - 160) + 'px'
    popover.style.left = Math.min(anchorLeft, window.innerWidth - 220) + 'px'
    popover.innerHTML =
      '<div style="font-size:11px;color:var(--ink3);font-weight:600;margin-bottom:8px">⏱ ' + esc(label) + '</div>' +
      '<div style="font-size:28px;font-weight:800;color:var(--forest);text-align:center;margin-bottom:8px;font-variant-numeric:tabular-nums">' + mins + ' min</div>' +
      '<input id="timer-range-slider" type="range" min="' + low + '" max="' + high + '" step="60" value="' + current + '" style="width:100%;accent-color:var(--forest);margin-bottom:12px" />' +
      '<div style="display:flex;gap:8px">' +
        '<button id="timer-slider-start" style="flex:1;background:var(--forest);color:white;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Start</button>' +
        '<button id="timer-slider-cancel" style="background:none;border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;cursor:pointer;font-family:inherit;color:var(--ink3)">✕</button>' +
      '</div>'
    document.body.appendChild(popover)

    document.getElementById('timer-range-slider')?.addEventListener('input', e => {
      state.timerSlider.current = parseInt(e.target.value)
      const m = Math.round(state.timerSlider.current / 60)
      popover.querySelector('div[style*="28px"]').textContent = m + ' min'
    })
    document.getElementById('timer-slider-start')?.addEventListener('click', () => {
      unlockAudio()
      startTimer(state.timerSlider.current, state.timerSlider.label)
      state.timerSlider = null
      popover.remove()
    })
    document.getElementById('timer-slider-cancel')?.addEventListener('click', () => {
      state.timerSlider = null
      popover.remove()
    })
    // Close on outside tap
    setTimeout(() => {
      document.addEventListener('click', e => {
        if (!popover.contains(e.target)) { state.timerSlider = null; popover.remove() }
      }, { once: true })
    }, 0)
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
      '<div style="margin-bottom:5px">' + selectAllBtn + '</div>' +
      '<div class="tag-filter-row">' + allTags.map(chipBtn).join('') + '</div>' +
    '</div>'
  }

  return '<div class="tag-filter-wrap">' +
    '<div style="margin-bottom:6px">' + selectAllBtn + '</div>' +
    '<div style="font-size:10px;color:var(--ink3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Category</div>' +
    '<div class="tag-filter-row" style="margin-bottom:8px">' + categories.map(chipBtn).join('') + '</div>' +
    '<div style="font-size:10px;color:var(--ink3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Style</div>' +
    '<div class="tag-filter-row">' + styles.map(chipBtn).join('') + '</div>' +
  '</div>'
}


function renderRecipeCard(r) {
  const isExpanded = state.expandedRecipe === r.id
  const pt = r.prepTime
  const prepSummary = pt
    ? '<div class="recipe-prep-summary">' +
        '⏱ ' + pt.active_min + ' min active' +
        (pt.passive_min > 0 ? ' + ' + pt.passive_min + ' min passive' : '') +
        ' · ' + (pt.difficulty || 'Unknown') +
        (pt.make_ahead && pt.make_ahead !== 'none' && pt.make_ahead !== 'None' ? ' · Make-ahead ✓' : '') +
      '</div>'
    : ''
  const header = '<div class="recipe-card" data-rid="' + r.id + '">' +
    '<div class="recipe-card-header">' +
      '<div>' +
        '<div class="recipe-name">' + esc(r.name) + '</div>' +
        ((r.tags&&r.tags.length) ? '<div class="recipe-tags-preview">' + r.tags.map(t => '<span class="tag-chip-small">' + esc(t) + '</span>').join('') + '</div>' : '') +
        prepSummary +
        (r.notes ? '<div class="recipe-meta">' + esc(r.notes) + '</div>' : '') +
        (r.clippedFrom ? '<div class="recipe-meta"><a href="' + esc(r.clippedFrom) + '" target="_blank" style="color:var(--forest2);text-decoration:none">&#128206; ' + esc((() => { try { return new URL(r.clippedFrom).hostname.replace('www.','') } catch(e) { return '' } })()) + '</a></div>' : '') +
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
  const mealTags = getTagsForNamespace('recipe').slice().sort((a, b) => a.name.localeCompare(b.name))
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
  const isScaling = state.scaleModal?.recipeId === r.id
  const scaleButtons = '<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">' +
    '<span style="font-size:10px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Scale:</span>' +
    ['½x', '2x', '3x'].map(s => '<button class="scale-btn" data-scale="' + s + '" data-recipe-id="' + r.id + '">' + s + '</button>').join('') +
  '</div>'
  const scaleResult = isScaling ? ('<div class="scale-result-box">' +
    (state.scaleModal.loading ? '<div style="color:var(--ink3);font-style:italic;font-size:12px">Scaling ingredients...</div>' :
      '<div style="font-size:11px;color:var(--ink3);font-weight:600;margin-bottom:6px">Scaled ingredients (' + state.scaleModal.label + '):</div>' +
      '<div class="recipe-text" style="background:var(--cream2);border-radius:8px;padding:8px">' + formatRecipeText(state.scaleModal.ingredients) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button class="add-btn" data-save-scaled="' + r.id + '">Save as new recipe</button>' +
        '<button class="modal-cancel" data-close-scale="' + r.id + '">Close</button>' +
      '</div>'
    ) + '</div>') : ''

  const body = '<div class="recipe-body">' +
    (r.clippedFrom ? '<div class="recipe-link"><a href="' + esc(r.clippedFrom) + '" target="_blank">View original</a></div>' : '') +
    scaleButtons +
    scaleResult +
    '<div class="recipe-section-label cooking-notes-label">Ingredients' +
      '<button class="notes-edit-btn" data-recipe-edit="' + r.id + '">' + (isEditingRecipe ? 'Done' : 'Edit') + '</button>' +
    '</div>' +
    (isEditingRecipe ?
      '<div style="margin-bottom:8px"><label style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Recipe Title</label>' +
      '<input class="notes-textarea" id="edit-recipe-name-' + r.id + '" value="' + esc(r.name) + '" style="margin-top:4px;font-weight:600" /></div>' +
      '<textarea class="notes-textarea" id="edit-ingredients-' + r.id + '" style="min-height:120px">' + esc(r.ingredients || '') + '</textarea>' +
      '<div class="recipe-section-label" style="margin-top:8px">Instructions</div>' +
      '<textarea class="notes-textarea" id="edit-instructions-' + r.id + '" style="min-height:120px">' + esc(r.instructions || '') + '</textarea>' +
      '<button class="notes-save-btn" data-recipe-save="' + r.id + '" style="margin-top:8px">Save Changes</button>'
    :
      (r.ingredients ? '<div class="recipe-text">' + formatRecipeText(r.ingredients) + '</div>' : '<div class="recipe-text" style="color:var(--ink4);font-style:italic">No ingredients yet -- tap Edit to add</div>')
    ) +
    (isEditingRecipe ? '' :
      '<div class="recipe-section-label">Instructions</div>' +
      (r.instructions ? '<div class="recipe-text">' + formatRecipeText(r.instructions) + '</div>' : (r.text ? '<div class="recipe-text">' + formatRecipeText(r.text) + '</div>' : ''))
    ) +
    '<div class="recipe-section-label cooking-notes-label">My Cooking Notes' +
      '<button class="notes-edit-btn" data-notes-edit="' + r.id + '">' + (state.editingNotes===r.id?'Done':'Edit') + '</button>' +
    '</div>' +
    notesSection +
    '<div class="tag-row">' + tagChips + tagPickerBtn + tagPicker + '</div>' +
    // Prep time at bottom
    (pt ? (
      '<div class="prep-time-box">' +
        '<div class="prep-time-header">' +
          '<span>⏱ Prep Time</span>' +
          '<button class="prep-time-refresh" data-refresh-prep="' + r.id + '" title="Re-estimate">' + (state.refreshingPrepId === r.id ? '...' : '↻') + '</button>' +
        '</div>' +
        '<div class="prep-time-grid">' +
          '<div class="prep-time-stat"><div class="prep-time-val">' + pt.active_min + ' min</div><div class="prep-time-label">Active</div></div>' +
          (pt.passive_min > 0 ? '<div class="prep-time-stat"><div class="prep-time-val">' + pt.passive_min + ' min</div><div class="prep-time-label">Passive</div></div>' : '') +
          '<div class="prep-time-stat"><div class="prep-time-val">' + (pt.difficulty||'?') + '</div><div class="prep-time-label">Difficulty</div></div>' +
          '<div class="prep-time-stat"><div class="prep-time-val">' + (pt.active_min + (pt.passive_min||0)) + ' min</div><div class="prep-time-label">Total</div></div>' +
        '</div>' +
        (pt.equipment && pt.equipment.length ? '<div class="prep-time-row"><span class="prep-time-key">🍳 Equipment:</span> ' + pt.equipment.join(', ') + '</div>' : '') +
        (pt.multitask ? '<div class="prep-time-row"><span class="prep-time-key">⚡ Multitask:</span> ' + esc(pt.multitask) + '</div>' : '') +
        (pt.make_ahead && pt.make_ahead !== 'none' && pt.make_ahead !== 'None' ? '<div class="prep-time-row"><span class="prep-time-key">🗓 Make-ahead:</span> ' + esc(pt.make_ahead) + '</div>' : '') +
        (pt.quick_version ? '<div class="prep-time-row"><span class="prep-time-key">⚡ Quick version:</span> ' + esc(pt.quick_version) + '</div>' : '') +
      '</div>'
    ) : (
      '<div class="prep-time-box prep-time-empty">' +
        '<button class="prep-time-estimate-btn" data-estimate-prep="' + r.id + '">' +
          (state.estimatingPrepId === r.id ? '⏳ Estimating...' : '⏱ Estimate prep time') +
        '</button>' +
      '</div>'
    )) +
    '<div class="recipe-actions">' +
      '<button class="ra-btn ra-shop" data-shop="' + r.id + '">Add to list</button>' +
      '<button class="ra-btn ra-log" data-log-recipe="' + r.id + '">Log meal</button>' +
      '<button class="ra-btn ra-log" data-add-to-week="' + r.id + '" data-add-name="' + esc(r.name) + '">+ Week</button>' +
      '<button class="ra-btn ra-plan" data-plan-recipe="' + r.id + '">📋 Plan</button>' +
      '<button class="ra-btn ra-ask" data-ask="' + r.id + '">Ask AI</button>' +
      (r.archived
        ? '<button class="ra-btn" data-restore-recipe="' + r.id + '" style="color:var(--forest)">↩ Restore</button>'
        : '<button class="ra-btn" data-archive-recipe="' + r.id + '" style="color:var(--ink3)">📦 Archive</button>') +
      '<button class="ra-btn ra-del" data-del="' + r.id + '">Del</button>' +
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
    const tags = (r.tags || []).slice(0, 3).map(t => `<span style="background:var(--sage4);color:var(--forest);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600">${esc(t)}</span>`).join('')
    if (!isExpanded) {
      return `<div class="recipe-list-row" data-expand-recipe="${r.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--cream3);cursor:pointer;background:white">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div>
          ${tags ? `<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">${tags}</div>` : ''}
        </div>
        <div style="font-size:18px;color:var(--ink3);flex-shrink:0">›</div>
      </div>`
    }
    // Expanded — show full card inline
    return `<div style="border-bottom:2px solid var(--forest2)">${renderRecipeCard(r)}</div>`
  }

  return `
    <div class="tab-content">
      <div class="section-header">
        <div class="section-title">My Recipe Box</div>
        <div style="display:flex;gap:6px">
          <button class="add-btn" id="scan-recipe-btn" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">Scan</button>
          <button class="add-btn" id="clip-url-btn-recipes" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">Clip URL</button>
          <button class="add-btn" id="add-recipe-btn">+ Add</button>
          <button class="add-btn" id="organize-tags-btn" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">🏷 Tags</button>
        </div>
      </div>
      <input type="file" id="scan-file-input" accept="image/*" capture="environment" style="display:none" />
      ${renderSearchBar('recipe-search', state.recipeSearch || '', 'Search recipes...')}
      ${state.allTags.some(t => t.namespace === 'recipe') ? renderTagFilterChips('recipe', 'Meal') : ''}

      <!-- Sort + View controls -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
        <div style="display:flex;gap:4px">
          <button class="recipe-sort-btn ${sort==='newest'?'active':''}" data-sort="newest" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='newest'?'var(--forest)':'var(--border)'};background:${sort==='newest'?'var(--forest)':'white'};color:${sort==='newest'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">Recent</button>
          <button class="recipe-sort-btn ${sort==='az'?'active':''}" data-sort="az" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='az'?'var(--forest)':'var(--border)'};background:${sort==='az'?'var(--forest)':'white'};color:${sort==='az'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">A→Z</button>
          <button class="recipe-sort-btn ${sort==='za'?'active':''}" data-sort="za" style="font-size:11px;padding:4px 9px;border-radius:6px;border:1.5px solid ${sort==='za'?'var(--forest)':'var(--border)'};background:${sort==='za'?'var(--forest)':'white'};color:${sort==='za'?'white':'var(--ink3)'};cursor:pointer;font-family:inherit">Z→A</button>
        </div>
        <div style="display:flex;gap:4px">
          <button id="view-cards-btn" title="Card view" style="font-size:16px;padding:4px 8px;border-radius:6px;border:1.5px solid ${!isListView?'var(--forest)':'var(--border)'};background:${!isListView?'var(--sage4)':'white'};cursor:pointer">⊟</button>
          <button id="view-list-btn" title="List view" style="font-size:16px;padding:4px 8px;border-radius:6px;border:1.5px solid ${isListView?'var(--forest)':'var(--border)'};background:${isListView?'var(--sage4)':'white'};cursor:pointer">☰</button>
        </div>
      </div>

      ${archivedCount > 0 ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <button id="toggle-archived-btn" style="font-size:12px;color:var(--ink3);background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-family:inherit">
            ${state.showArchived ? '← Back to recipes' : '📦 Archived (' + archivedCount + ')'}
          </button>
        </div>
      ` : ''}
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
      ` : isListView
          ? `<div style="border-radius:12px;overflow:hidden;border:1px solid var(--cream3)">${filtered.map(r => renderListRow(r)).join('')}</div>`
          : filtered.map(r => renderRecipeCard(r)).join('')
      }
    </div>`
}

function renderPantry() {
  const locationTags = state.activeTagFilters['location']
  const search = (state.pantrySearch || '').toLowerCase()
  const filtered = state.pantry.filter(item =>
    (!locationTags || locationTags.size === 0 || [...locationTags].some(t => (item.tags||[]).includes(t))) &&
    (!search || item.name.toLowerCase().includes(search))
  )
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
      filtered.map(function(item) {
        const chips = (item.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + item.id + '" data-tag-ns="location">x</button></span>').join('')
        const pickerId = item.id + '-location'
        const isOpen = state.tagPickerOpen === pickerId
        const pantryTags = getTagsForNamespace('location').slice().sort((a, b) => a.name.localeCompare(b.name))
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

// ── SHOP LIST RENDERING ───────────────────────────────────────────────────────

function renderShopItems(items) {
  return items.map(function(i) {
    const chips = (i.tags||[]).map(t => '<span class="tag-chip">' + esc(t) + '<button class="tag-chip-remove" data-remove-tag="' + esc(t) + '" data-tag-item="' + i.id + '" data-tag-ns="location">x</button></span>').join('')
    const pickerId = i.id + '-location'
    const isOpen = state.tagPickerOpen === pickerId
    const storeTags = getTagsForNamespace('location').slice().sort((a, b) => a.name.localeCompare(b.name))
    const picker = isOpen ? ('<div class="tag-picker-popover" id="tag-picker-popover" style="' + tagPickerStyle() + '">' + storeTags.map(t => '<label class="tag-picker-option"><input type="checkbox" class="tag-picker-check" data-pick-tag="' + esc(t.name) + '" data-tag-item="' + i.id + '" data-tag-ns="location" ' + ((i.tags||[]).includes(t.name)?'checked':'') + ' />' + esc(t.name) + '</label>').join('') + '<div class="tag-picker-new"><input class="tag-picker-input" id="new-tag-' + i.id + '-location" placeholder="New tag..." /><button class="tag-picker-add" data-new-tag-item="' + i.id + '" data-new-tag-ns="location">Add</button></div></div>') : ''
    const isEditingS = state.editingShopId === String(i.id)

    const isChecked = !!i.have

    return '<div class="shop-row" style="' + (isChecked ? 'opacity:0.6' : '') + '">' +
      '<div class="shop-check' + (isChecked ? ' shop-check-done' : '') + '" data-check="' + i.id + '"></div>' +
      '<div class="shop-item-main">' +
      (isEditingS ?
        '<input class="shop-edit-name" data-edit-shop-name="' + i.id + '" value="' + esc(i.name) + '" style="width:100%;padding:5px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-size:13px;font-family:inherit;margin-bottom:4px" />' +
        '<button class="add-btn" data-save-shop="' + i.id + '" style="padding:4px 10px;font-size:11px">Save</button>'
      :
        '<div class="shop-item-name" data-edit-shop="' + i.id + '" style="cursor:pointer;' + (isChecked ? 'text-decoration:line-through;color:var(--ink4)' : '') + '" title="Tap to edit">' + esc(i.name) + '</div>'
      ) +
      '<div class="shop-item-tags">' +
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
  const locationTags = state.activeTagFilters['location']
  const search = (state.shopSearch || '').toLowerCase()

  const need = sortShopList(state.shopList.filter(i =>
    !i.have &&
    (!locationTags || locationTags.size === 0 || [...locationTags].some(t => (i.tags||[]).includes(t))) &&
    (!search || i.name.toLowerCase().includes(search))
  ))
  const done = state.shopList.filter(i => i.have)

  return '<div class="tab-content">' +
    '<div class="shop-header">' +
      '<div class="section-title">Shopping List</div>' +
      '<div style="display:flex;gap:6px">' +
        (state.shopList.length > 0 ? '<button class="icon-btn" id="shop-copy-btn">Copy</button>' : '') +
        (done.length > 0 ? '<button class="clear-pantry-btn" id="shop-clear-checked" style="background:var(--cream2);color:var(--ink2);border:1px solid var(--border)">Clear checked (' + done.length + ')</button>' : '') +
        (state.shopList.length > 0 ? '<button class="clear-pantry-btn" id="shop-clear">Clear all</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="shop-add-row">' +
      '<input id="shop-manual-input" placeholder="Add item manually..." />' +
      '<button class="add-btn" id="shop-manual-add">+ Add</button>' +
    '</div>' +
    (getTagsForNamespace('location').length > 0 ?
      '<div style="margin-top:6px;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' +
      '<span style="font-size:10px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Tag:</span>' +
      getTagsForNamespace('location').map(t =>
        '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="shop-new-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--forest)" />' +
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
    : (state.shopList.length > 0 && need.length === 0 && done.length > 0 ? '<div style="font-size:13px;color:var(--ink3);padding:12px 0;text-align:center">✅ All done! Items will clear in 1 hour.</div>' : '')) +
    // Checked / crossed-off items
    (done.length > 0 ?
      '<div style="margin-top:14px;border-top:1px solid var(--cream3);padding-top:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<div style="font-size:10px;color:var(--ink4);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">In cart (' + done.length + ')</div>' +
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
  // Build week data from historyLog + today's log
  const weekDays = []
  for (let i = 0; i <= 6; i++) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    weekDays.push(d.toLocaleDateString('sv'))
  }
  const today = now.toLocaleDateString('sv')

  const byDate = {}
  ;(state.historyLog || []).forEach(e => {
    const d = new Date(e.logged_at).toLocaleDateString('sv')
    if (!byDate[d]) byDate[d] = []
    byDate[d].push(e)
  })
  byDate[today] = state.log

  const weeklyIn = weekDays.reduce((sum, d) => sum + (byDate[d] || []).reduce((s,e) => s+(e.calories||0), 0), 0)
  const weeklyOut = 0 // exercise history not yet stored — today only
  const weeklyNet = weeklyIn - weeklyOut
  const weeklyGoal = goal * 7
  const weeklyDiff = weeklyNet - weeklyGoal
  const deficitSurplus = weeklyDiff < 0
    ? { label: Math.abs(weeklyDiff).toLocaleString() + ' cal deficit', color: 'var(--forest)', bg: 'var(--sage4)' }
    : weeklyDiff > 0
    ? { label: weeklyDiff.toLocaleString() + ' cal surplus', color: 'var(--terra)', bg: '#fff5f2' }
    : { label: 'On target', color: 'var(--forest)', bg: 'var(--sage4)' }

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
              '<span style="font-size:11px;color:var(--ink3)">kcal</span>' +
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
          (e.recipe_id ? '<button class="log-recipe-link" data-go-recipe="' + e.recipe_id + '">recipe</button>' : '') +
          '<button class="remove-btn" data-log-del="' + e.id + '">x</button>' +
        '</div>'
      }).join('')

  // Weekly breakdown rows
  const weekRows = weekDays.map(d => {
    const entries = byDate[d] || []
    const dayCals = entries.reduce((s, e) => s + (e.calories || 0), 0)
    const isDayToday = d === today
    const diff = dayCals - goal
    const wDayLabel = isDayToday ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const foods = entries.slice(0, 3).map(e => esc(e.food)).join(', ') + (entries.length > 3 ? ' +' + (entries.length - 3) + ' more' : '')
    const barPct = Math.min((dayCals / goal) * 100, 100)
    const barColor = diff > 200 ? 'var(--terra)' : diff > 0 ? 'var(--gold)' : 'var(--forest2)'
    return '<div style="padding:8px 0;border-bottom:1px solid var(--cream2)' + (isDayToday ? ';background:var(--sage4);border-radius:8px;padding:8px;margin:-2px 0' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
        '<span style="font-size:12px;font-weight:' + (isDayToday ? '700' : '500') + ';color:' + (isDayToday ? 'var(--forest)' : 'var(--ink)') + '">' + wDayLabel + '</span>' +
        '<span style="font-size:12px;font-weight:600;color:var(--ink2)">' + (dayCals > 0 ? dayCals + ' cal' : '--') + '</span>' +
      '</div>' +
      (dayCals > 0 ? '<div style="height:3px;background:var(--cream3);border-radius:2px;margin-bottom:3px"><div style="height:100%;width:' + barPct + '%;background:' + barColor + ';border-radius:2px"></div></div>' : '') +
      (foods ? '<div style="font-size:10px;color:var(--ink3)">' + foods + '</div>' : '') +
    '</div>'
  }).join('')

  return '<div class="tab-content" id="log-tab-content">' +

    // 1. Day navigation
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<button class="cal-nav" id="log-prev-day">&#8249;</button>' +
      '<div style="text-align:center">' +
        '<div style="font-size:15px;font-weight:700;color:var(--forest)">' + dayLabel + '</div>' +
        (!isToday ? '<div style="font-size:11px;color:var(--ink3)">' + viewedDate.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) + '</div>' : '') +
      '</div>' +
      '<button class="cal-nav" id="log-next-day" ' + (isToday ? 'disabled style="opacity:0.3"' : '') + '>&#8250;</button>' +
    '</div>' +

    // 2. Daily summary
    '<div class="log-total">' +
      '<div>' +
        '<div class="log-total-label">' + (isToday ? 'Today' : dayLabel) + '</div>' +
        '<div class="log-total-sub">' + (rem > 0 ? rem + ' remaining' : Math.abs(rem) + ' over goal') + '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        (burned > 0 ?
          '<div style="font-size:11px;color:var(--ink3)">&#127869; ' + cals + ' in &nbsp;&#127939; ' + burned + ' out</div>' +
          '<div><span class="log-total-val">' + net + '</span><span class="log-total-goal"> net / ' + goal + '</span></div>'
        :
          '<div><span class="log-total-val">' + cals + '</span><span class="log-total-goal"> / ' + goal + '</span></div>'
        ) +
      '</div>' +
    '</div>' +

    // 3. Log weight
    (state.goals.target_weight ? (
      '<div class="log-add-row" style="margin-bottom:10px">' +
        '<input id="log-weight-input" type="number" step="0.1" placeholder="Log weight (lbs)" style="flex:1" value="' + ((() => {
          const existing = (state.weightLog || []).find(e => new Date(e.logged_at).toLocaleDateString('sv') === viewedDateStr)
          return existing ? existing.weight : ''
        })()) + '" />' +
        '<button class="add-btn" id="log-weight-btn" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">' + ((state.weightLog || []).find(e => new Date(e.logged_at).toLocaleDateString('sv') === viewedDateStr) ? '&#9998; Update' : '&#9881; Log') + ' Weight</button>' +
      '</div>'
    ) : '') +

    // 4. Today's meals
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px">&#127869; ' + (isToday ? "Today's" : dayLabel + "'s") + ' meals</div>' +
    logEntries +

    // 5. Search recipes + tags + add food
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
      '<input id="log-food" placeholder="e.g. cheerios half cup, whole milk half cup" style="flex:1" />' +
      '<button class="add-btn" id="log-add-btn">+ Add</button>' +
    '</div>' +
    (!isToday ? '<div style="font-size:10px;color:var(--ink3);margin-bottom:8px;font-style:italic">Adding to ' + dayLabel + '</div>' : '') +

    // 6. Exercise
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 6px">&#127939; Exercise</div>' +
    '<div class="log-add-row">' +
      '<input id="log-exercise" placeholder="e.g. swam 1 hour, walked 30 min" style="flex:1" />' +
      '<button class="add-btn" id="log-exercise-btn" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">+ Add</button>' +
    '</div>' +
    (viewedExercise && viewedExercise.length > 0 ?
      viewedExercise.map(e =>
        '<div class="log-entry">' +
          '<div style="flex:1">' +
            '<div class="log-food">' + esc(e.activity) + '</div>' +
            '<div class="log-cal-row-entry">' +
              '<span class="log-cal" style="color:var(--forest)">-' + e.calories_burned + ' kcal burned</span>' +
              (e.calories_burned > 0 ? '<button class="log-breakdown-btn" data-ex-breakdown-id="' + e.id + '">?</button>' : '') +
            '</div>' +
            (state.logBreakdownId === 'ex-' + e.id && e.breakdown ?
              '<div class="log-breakdown-text">' + esc(e.breakdown) + '</div>' : '') +
          '</div>' +
          '<button class="remove-btn" data-ex-del="' + e.id + '">x</button>' +
        '</div>'
      ).join('')
    : '<div style="font-size:12px;color:var(--ink4);padding:4px 0 8px">No exercise logged' + (isToday ? ' today' : ' this day') + '</div>') +

    // 7. Weight progress graph
    renderWeightProgress() +

    // 8. Last 7 days summary bar
    '<div style="background:' + deficitSurplus.bg + ';border-radius:10px;padding:8px 12px;margin-top:16px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">' +
      '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Last 7 days</div>' +
      '<div style="font-size:12px;font-weight:700;color:' + deficitSurplus.color + '">' + deficitSurplus.label + '</div>' +
      '<div style="font-size:11px;color:var(--ink3)">' + weeklyIn.toLocaleString() + ' / ' + weeklyGoal.toLocaleString() + ' cal</div>' +
    '</div>' +

    // 9. This week day-by-day breakdown (newest first)
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 6px">This week</div>' +
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

  // Actual trajectory from latest weigh-in
  let actualTrajectoryDate = null
  let nudgeMsg = '', nudgeColor = 'var(--ink3)'
  if (weightLog.length >= 2) {
    const first = weightLog[0], last = weightLog[weightLog.length-1]
    const daysBetween = Math.round((new Date(last.logged_at) - new Date(first.logged_at)) / (1000*60*60*24))
    if (daysBetween > 0) {
      const actualLbsPerDay = (parseFloat(first.weight) - parseFloat(last.weight)) / daysBetween
      if (actualLbsPerDay > 0) {
        const daysToGoal = (parseFloat(last.weight) - parseFloat(target_weight)) / actualLbsPerDay
        actualTrajectoryDate = new Date(new Date(last.logged_at))
        actualTrajectoryDate.setDate(actualTrajectoryDate.getDate() + Math.round(daysToGoal))
        if (actualTrajectoryDate > endDate) endDate = new Date(actualTrajectoryDate)
        const projEndDate = projection ? new Date(startDate.getTime() + projection.days * 86400000) : null
        const diffDays = projEndDate ? Math.round((projEndDate - actualTrajectoryDate) / 86400000) : 0
        const diffWeeks = Math.round(Math.abs(diffDays) / 7)
        if (diffDays > 14) { nudgeMsg = '🎉 ' + diffWeeks + 'w ahead of schedule!'; nudgeColor = 'var(--forest)' }
        else if (diffDays > 0) { nudgeMsg = '✅ Slightly ahead!'; nudgeColor = 'var(--forest2)' }
        else if (diffDays < -14) { nudgeMsg = '💪 ' + diffWeeks + 'w behind — tighten up a bit.'; nudgeColor = 'var(--terra)' }
        else if (diffDays < 0) { nudgeMsg = '📊 Slightly behind — keep going!'; nudgeColor = 'var(--gold)' }
        else { nudgeMsg = '🎯 Right on track!'; nudgeColor = 'var(--forest)' }
      }
    }
  }

  const totalDays = Math.max(Math.round((endDate - startDate) / 86400000), 30)
  const lbsPerDay = projection ? (startWeight - parseFloat(target_weight)) / projection.days : 0

  // Projected line — starts at startWeight on startDate, goes to target
  const projPoints = projection ? Array.from({length: Math.min(totalDays, projection.days) + 1}, (_, i) => ({
    day: i,
    weight: Math.max(parseFloat((startWeight - lbsPerDay * i).toFixed(2)), parseFloat(target_weight))
  })) : []

  // Actual weigh-in points plotted by date — filter out any bad values
  const actualPoints = weightLog
    .filter(e => parseFloat(e.weight) > 0)
    .map(e => ({
      day: Math.round((new Date(e.logged_at) - startDate) / 86400000),
      weight: parseFloat(e.weight),
      id: e.id,
      date: new Date(e.logged_at)
    })).filter(p => p.day >= 0)

  // Current trajectory line from latest actual point
  const trajPoints = (actualPoints.length >= 1 && weightLog.length >= 2) ? (() => {
    const last = actualPoints[actualPoints.length-1]
    const first = actualPoints[0]
    const daysBetween = last.day - first.day
    if (daysBetween <= 0) return []
    const actualLbsPerDay = (first.weight - last.weight) / daysBetween
    if (actualLbsPerDay <= 0) return [last]
    const daysToGoal = (last.weight - parseFloat(target_weight)) / actualLbsPerDay
    const pts = []
    const steps = Math.min(Math.ceil(daysToGoal), totalDays - last.day)
    for (let i = 0; i <= steps; i += Math.max(1, Math.floor(steps/20))) {
      pts.push({ day: last.day + i, weight: Math.max(last.weight - actualLbsPerDay * i, parseFloat(target_weight)) })
    }
    return pts
  })() : []

  // Month labels
  const monthLabels = []
  const cursor = new Date(startDate)
  cursor.setDate(1); cursor.setMonth(cursor.getMonth() + 1)
  while (cursor <= endDate) {
    monthLabels.push({ day: Math.round((cursor - startDate) / 86400000), label: cursor.toLocaleDateString('en-US', {month:'short'}) })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  // SVG
  const allW = [startWeight + 2, parseFloat(target_weight) - 1, ...actualPoints.map(p => p.weight)]
  const minW = Math.floor(Math.min(...allW))
  const maxW = Math.ceil(Math.max(...allW))
  const W = 320, H = 155, padL = 32, padR = 12, padT = 12, padB = 28
  const xScale = d => padL + (Math.min(Math.max(d,0), totalDays) / totalDays) * (W - padL - padR)
  const yScale = w => padT + ((maxW - w) / (maxW - minW)) * (H - padT - padB)

  const yStep = (maxW - minW) <= 10 ? 2 : 5
  const yGridLines = []
  for (let w = Math.ceil(minW / yStep) * yStep; w <= maxW; w += yStep) yGridLines.push(w)

  const mkPath = pts => pts.map((p,i) => (i===0?'M':'L') + xScale(p.day).toFixed(1) + ' ' + yScale(p.weight).toFixed(1)).join(' ')

  const projPath = projPoints.length > 1 ? mkPath(projPoints.filter((_,i)=>i%3===0||i===projPoints.length-1)) : ''
  const actualPath = actualPoints.length > 1 ? mkPath(actualPoints) : ''
  const trajPath = trajPoints.length > 1 ? mkPath(trajPoints) : ''

  // Start dot (at startWeight on startDate)
  const startDotY = yScale(startWeight)
  const startDotX = xScale(0)

  return '<div style="margin-top:16px">' +
    '<div style="font-size:11px;color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">&#9878; Weight Progress</div>' +
    '<div style="background:white;border:1.5px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px">' +

      // Stats: Start · Current · Lost · To go · Target
      '<div style="display:flex;justify-content:space-between;margin-bottom:12px">' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--ink3)">' + startWeight + '</div><div style="font-size:10px;color:var(--ink3)">Start</div></div>' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--forest)">' + latestWeight + '</div><div style="font-size:10px;color:var(--ink3)">Current</div></div>' +
        (lostSoFar > 0.1 ? '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--forest2)">-' + lostSoFar.toFixed(1) + '</div><div style="font-size:10px;color:var(--ink3)">Lost</div></div>' : '') +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--ink2)">' + toGo.toFixed(1) + '</div><div style="font-size:10px;color:var(--ink3)">To go</div></div>' +
        '<div style="text-align:center"><div style="font-size:16px;font-weight:800;color:var(--terra)">' + target_weight + '</div><div style="font-size:10px;color:var(--ink3)">Target</div></div>' +
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

        // Start date marker
        '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H-padB) + '" stroke="var(--forest2)" stroke-width="1" opacity="0.4"/>' +
        '<text x="' + padL + '" y="' + (H-padB+12) + '" text-anchor="middle" font-size="8" font-weight="bold" fill="var(--forest2)">' + startDate.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + '</text>' +

        // Month labels
        monthLabels.map(m =>
          '<line x1="' + xScale(m.day).toFixed(1) + '" y1="' + padT + '" x2="' + xScale(m.day).toFixed(1) + '" y2="' + (H-padB) + '" stroke="var(--cream3)" stroke-width="1" stroke-dasharray="2,3"/>' +
          '<text x="' + xScale(m.day).toFixed(1) + '" y="' + (H-padB+12) + '" text-anchor="middle" font-size="8" fill="var(--ink3)">' + m.label + '</text>'
        ).join('') +

        // Start weight dot (anchor of the projected line)
        '<circle cx="' + startDotX.toFixed(1) + '" cy="' + startDotY.toFixed(1) + '" r="4" fill="var(--ink3)" stroke="white" stroke-width="1.5"/>' +
        '<text x="' + (startDotX+7).toFixed(1) + '" y="' + (startDotY-5).toFixed(1) + '" font-size="8" font-weight="bold" fill="var(--ink3)">' + startWeight + '</text>' +

        // Plan line (solid grey — the ideal straight path from start to goal)
        (projPath ? '<path d="' + projPath + '" fill="none" stroke="var(--ink4)" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.6"/>' : '') +

        // Actual trajectory forward (colored dashed — extrapolated from your actual pace)
        (trajPath ? '<path d="' + trajPath + '" fill="none" stroke="' + nudgeColor + '" stroke-width="1.5" stroke-dasharray="6,3" opacity="0.8"/>' : '') +

        // Actual logged weights (dotted green — your real journey connecting weigh-ins)
        (actualPath ? '<path d="' + actualPath + '" fill="none" stroke="var(--forest)" stroke-width="2" stroke-dasharray="4,3" stroke-linejoin="round"/>' : '') +

        // Actual dots with date labels
        actualPoints.map((p, i) => {
          const cx = xScale(p.day), cy = yScale(p.weight)
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
          const dateLabel = p.date.toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone: tz})
          const labelX = cx > W - 50 ? cx - 6 : cx + 6
          const anchor = cx > W - 50 ? 'end' : 'start'
          const labelY = cy > H - padB - 20 ? cy - 10 : cy + 14
          const isLatest = i === actualPoints.length - 1
          return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (isLatest ? 4.5 : 3.5) + '" fill="var(--forest)" stroke="white" stroke-width="1.5"/>' +
            '<text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="' + anchor + '" font-size="7" fill="var(--ink3)">' + dateLabel + '</text>' +
            (isLatest ? '<text x="' + (cx > W-60 ? cx-6 : cx+6).toFixed(1) + '" y="' + (cy-7).toFixed(1) + '" text-anchor="' + (cx>W-60?'end':'start') + '" font-size="8" font-weight="bold" fill="var(--forest)">' + p.weight + '</text>' : '')
        }).join('') +

      '</svg>' +

      // Dates line
      (projection ? '<div style="font-size:11px;color:var(--ink3);margin-top:4px;text-align:center">Original: <strong>' + projection.date + '</strong>' +
        (actualTrajectoryDate ? ' &nbsp;·&nbsp; At your pace: <strong style="color:' + nudgeColor + '">' + actualTrajectoryDate.toLocaleDateString('en-US', {month:'long', day:'numeric'}) + '</strong>' : '') +
      '</div>' : '') +

      // Nudge
      (nudgeMsg ? '<div style="font-size:12px;font-weight:600;color:' + nudgeColor + ';margin-top:8px;text-align:center;padding:6px 10px;background:var(--cream2);border-radius:8px">' + nudgeMsg + '</div>' : '') +

      // Legend
      '<div style="display:flex;gap:12px;justify-content:center;margin-top:8px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--forest)" stroke-width="2" stroke-dasharray="4,3"/></svg>Your weigh-ins</div>' +
        (trajPath ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="' + nudgeColor + '" stroke-width="1.5" stroke-dasharray="5,3"/></svg>Your pace</div>' : '') +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--ink4)" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.6"/></svg>Plan</div>' +
        '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink3)"><svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="var(--terra)" stroke-width="1.5" stroke-dasharray="4,3"/></svg>Target</div>' +
      '</div>' +

    '</div>' +

    // Recent weigh-ins list
    (weightLog.length > 0 ?
      '<div style="margin-top:8px">' +
        weightLog.slice().reverse().slice(0, 5).map(e =>
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--cream2)">' +
            '<span style="font-size:13px;font-weight:600">' + e.weight + ' lbs</span>' +
            '<span style="font-size:11px;color:var(--ink3)">' + new Date(e.logged_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}) + '</span>' +
            '<button class="remove-btn" data-weight-del="' + e.id + '">x</button>' +
          '</div>'
        ).join('') +
      '</div>'
    : '<div style="font-size:12px;color:var(--ink4);padding:4px 0">Log your first weigh-in to start tracking!</div>') +

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
    const today = isDateToday(date)
    const dateMeals = state.mealPlan.filter(e => e.date === date && e.recipe_id)
    html += '<div class="cal-day ' + (today ? 'cal-day-today' : '') + '">'
    html += '<div class="cal-day-header">'
    html += '<span class="cal-day-name">' + DAY_NAMES[idx] + '</span>'
    html += '<span class="cal-day-date">' + formatDate(date).split(', ')[1] + '</span>'
    if (dateMeals.length > 0) {
      const dinnerDefault = localStorage.getItem('mep_dinner_time') || '7:00 PM'
      html += '<button class="cal-game-plan-btn" data-game-plan-slot="Day" data-game-plan-date="' + date + '" data-game-plan-rid="" data-game-plan-time="' + esc(dinnerDefault) + '" style="margin-left:auto;font-size:10px;padding:3px 9px;background:var(--forest);color:white;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">📋 Plan Day</button>'
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
        html += '<button class="cal-game-plan-btn" data-game-plan-slot="' + slot + '" data-game-plan-date="' + date + '" data-game-plan-rid="" data-game-plan-time="' + esc(defaultTime) + '" style="font-size:10px;padding:2px 7px;background:var(--forest);color:white;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">📋 Plan</button>'
      }
      html += '</div>'

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
  const search = (state.tagSearch || '').toLowerCase()
  const namespaces = [
    { key: 'recipe', label: 'Recipe Tags', hint: 'For recipes - meal type, occasion, cooking method, main ingredient' },
    { key: 'location', label: 'Pantry/Store Tags', hint: 'For pantry items and shopping list - store aisle or home storage location' },
  ]
  return '<div class="tab-content">' +
    '<div class="section-title">Tag Library</div>' +
    renderSearchBar('tag-search', state.tagSearch || '', 'Search tags...') +
    namespaces.map(ns => {
      const tags = getTagsForNamespace(ns.key).filter(t => !search || t.name.toLowerCase().includes(search))
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
      '<button class="chat-recipe-link" data-go-recipe="' + r.id + '" style="background:none;border:none;padding:0;color:var(--forest);font-weight:700;text-decoration:underline dotted;cursor:pointer;font-family:inherit;font-size:inherit">' + escapedName + '</button>'
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
      '<div style="background:var(--sage4);border-bottom:1.5px solid var(--forest2);padding:8px 14px;display:flex;justify-content:space-between;align-items:center">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<button id="chat-back-to-recipe" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--forest);padding:0;line-height:1;font-family:inherit" title="Back to recipe">←</button>' +
          '<div>' +
            '<div style="font-size:10px;color:var(--forest);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Asking about</div>' +
            '<button id="chat-go-to-recipe" style="background:none;border:none;padding:0;cursor:pointer;font-size:13px;font-weight:700;color:var(--forest);text-decoration:underline dotted;font-family:inherit;text-align:left">' + esc(ctx.name) + '</button>' +
          '</div>' +
        '</div>' +
        '<button id="chat-clear-context" style="font-size:11px;color:var(--ink3);background:none;border:1px solid var(--border);border-radius:6px;padding:2px 8px;cursor:pointer">✕ Clear</button>' +
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

  // Helper — trim instructions if too long, keep ingredients full
  const recipeDetail = (entry, recipe) => {
    const pt = recipe?.prepTime
    const instructions = recipe?.instructions || ''
    // Trim instructions to 600 chars if multiple recipes to avoid token overflow
    const instTrimmed = instructions.length > 600 ? instructions.slice(0, 600) + '...' : instructions
    return '=== ' + (entry.meal_slot ? entry.meal_slot + ': ' : '') + entry.recipe_name + ' ===\n' +
      (pt ? 'Prep data: ' + JSON.stringify(pt) + '\n' : '') +
      (recipe?.ingredients ? 'Ingredients:\n' + recipe.ingredients + '\n' : '') +
      (instTrimmed ? 'Instructions:\n' + instTrimmed : '')
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

  // Safety check — if still very large, trim further
  if (mealText.length > 4000) {
    mealText = mealText.slice(0, 4000) + '\n...(recipe details trimmed for length)'
  }

  const now = new Date()
  const currentTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  const mealDate = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'today'
  const isToday = date === new Date().toISOString().slice(0, 10)

  const slotLabel = isWholeDay ? 'the whole day' : slot
  const prompt = `You are a cooking assistant. List the cooking steps needed for this meal and how long each step takes.

MEAL: ${mealDate} at ${targetTime}
${notes ? 'USER NOTES: ' + notes : ''}

RECIPES:
${mealText}

List every step needed to cook this meal. For each step include:
- What to do (with exact quantities)
- How many minutes it takes (active time)
- How many minutes of passive/wait time after (oven, simmer, rest) — 0 if none

Return ONLY a JSON array:
[
  {"step": "Preheat oven to 425°F", "active_min": 1, "passive_min": 20},
  {"step": "Prep chicken thighs — pat dry, coat with 2 tbsp olive oil, season with salt and pepper", "active_min": 5, "passive_min": 0},
  {"step": "Roast chicken in oven", "active_min": 2, "passive_min": 40},
  {"step": "Make pan sauce — deglaze with 1/2 cup white wine, add 2 tbsp butter", "active_min": 8, "passive_min": 0},
  {"step": "Rest chicken, plate and serve", "active_min": 3, "passive_min": 0}
]

Rules:
- Include exact amounts inline ("2 tbsp olive oil" not "olive oil")
- Overlap passive steps with active steps where realistic (prep veggies while chicken roasts)
- 6-8 steps for one recipe, up to 12 for multiple
- No markdown, no backticks, just the JSON array`

  try {
    let resp, attempts = 0
    while (attempts < 3) {
      resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 3000,
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
      const stepTime = isTodayMeal && cursor < nowMins ? nowMins : cursor
      result.unshift({ time: formatTime(stepTime), step: s.step })
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
        '<div style="text-align:center;padding:30px 0;color:var(--ink3)">Asking AI to sort your tags...</div>' +
      '</div>' +
    '</div>'
  }
  const tags = m.tags || []
  const renderTagRow = (t) => {
    const type = t.tag_type || 'category'
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--cream3)">' +
      '<div style="flex:1;font-size:13px;font-weight:600;color:var(--ink)">' + esc(t.name) + '</div>' +
      '<div style="display:flex;gap:4px">' +
        '<button class="tag-type-btn ' + (type === 'category' ? 'active' : '') + '" data-tag-id="' + t.id + '" data-tag-type="category" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1.5px solid ' + (type==='category'?'var(--forest)':'var(--border)') + ';background:' + (type==='category'?'var(--forest)':'white') + ';color:' + (type==='category'?'white':'var(--ink3)') + ';cursor:pointer;font-family:inherit">Category</button>' +
        '<button class="tag-type-btn ' + (type === 'style' ? 'active' : '') + '" data-tag-id="' + t.id + '" data-tag-type="style" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1.5px solid ' + (type==='style'?'var(--forest)':'var(--border)') + ';background:' + (type==='style'?'var(--forest)':'white') + ';color:' + (type==='style'?'white':'var(--ink3)') + ';cursor:pointer;font-family:inherit">Style</button>' +
      '</div>' +
    '</div>'
  }
  return '<div class="modal-bg" id="tag-organizer-bg">' +
    '<div class="modal-sheet" style="max-height:85vh;overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<div class="modal-title" style="margin:0">🏷 Organize Tags</div>' +
        '<button id="tag-organizer-close" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--ink3);padding:0;line-height:1">×</button>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Category = what the dish is (Pork, Pasta). Style = how it\'s made (Sous Vide, Weeknight). Filtering uses Category as OR, then Style to narrow.</div>' +
      tags.sort((a, b) => a.name.localeCompare(b.name)).map(renderTagRow).join('') +
      '<div style="margin-top:16px">' +
        '<button class="modal-save" id="tag-organizer-save" style="width:100%">Save</button>' +
      '</div>' +
    '</div>' +
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

  // ── CHAT VIEW ──
  if (view === 'chat') {
    const bubbles = chatMessages.map(m =>
      '<div style="display:flex;flex-direction:column;align-items:' + (m.role === 'user' ? 'flex-end' : 'flex-start') + ';margin-bottom:10px">' +
        '<div style="max-width:85%;background:' + (m.role === 'user' ? 'var(--forest)' : 'var(--cream2)') + ';color:' + (m.role === 'user' ? 'white' : 'var(--ink)') + ';border-radius:14px;padding:10px 13px;font-size:13px;line-height:1.5">' +
          (m.role === 'assistant' ? linkifyTimers(esc(m.content).replace(/\n/g, '<br>')) : esc(m.content).replace(/\n/g, '<br>')) +
        '</div>' +
      '</div>'
    ).join('')

    return '<div class="modal-bg" id="game-plan-bg">' +
      '<div class="modal-sheet" style="max-height:90vh;display:flex;flex-direction:column;padding:0;overflow:hidden">' +
        '<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--cream3);flex-shrink:0">' +
          '<button id="gp-back-to-timeline" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--forest);padding:0;line-height:1;font-family:inherit">←</button>' +
          '<div style="flex:1;display:flex;align-items:center;gap:8px">' +
            '<div>' +
              '<div style="font-size:14px;font-weight:700;color:var(--forest)">✦ Game Plan</div>' +
              '<div style="font-size:11px;color:var(--ink3)">' + slotLabel + ' · ' + dateLabel + '</div>' +
            '</div>' +
            '<button id="gp-start-over" style="font-size:11px;color:var(--ink3);background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;font-family:inherit">↺ Redo</button>' +
          '</div>' +
          '<button id="gp-close" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--ink3);padding:0;line-height:1">×</button>' +
        '</div>' +
        '<div id="gp-chat-messages" style="flex:1;overflow-y:auto;padding:14px 16px;min-height:0">' +
          (chatMessages.length === 0
            ? '<div style="color:var(--ink4);font-size:13px;font-style:italic;text-align:center;padding:20px 0">What tweaks would you like to make?</div>'
            : bubbles) +
          (chatLoading ? '<div style="text-align:center;padding:10px;color:var(--ink3);font-size:13px">thinking...</div>' : '') +
        '</div>' +
        '<div style="padding:10px 12px;border-top:1px solid var(--cream3);display:flex;gap:8px;flex-shrink:0">' +
          '<input id="gp-chat-input" placeholder="e.g. I can start at 4:30pm..." style="flex:1;padding:9px 12px;border:1.5px solid var(--border);border-radius:12px;font-size:13px;font-family:inherit" />' +
          '<button id="gp-chat-send" style="background:var(--forest);color:white;border:none;border-radius:12px;padding:9px 14px;font-size:16px;cursor:pointer" ' + (chatLoading ? 'disabled' : '') + '>▶</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  }

  // ── TIMELINE VIEW ──
  let content = ''
  if (loading) {
    content = '<div style="text-align:center;padding:30px 0">' +
      '<div style="font-size:28px;margin-bottom:10px">📋</div>' +
      '<div style="font-size:14px;font-weight:600;color:var(--forest)">Planning your ' + slotLabel.toLowerCase() + '...</div>' +
      '<div style="font-size:12px;color:var(--ink3);margin-top:6px">Reading your recipes and building a timeline</div>' +
      '</div>'
  } else if (result) {
    content =
      '<div style="margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="font-size:12px;color:var(--ink3)">' + (isWholeDay ? 'Dinner' : slotLabel) + ' at</span>' +
        '<input id="gp-dinner-time" value="' + esc(timeVal) + '" style="width:90px;padding:5px 8px;border:1.5px solid var(--forest2);border-radius:8px;font-size:13px;font-family:inherit;text-align:center" />' +
        '<button class="add-btn" id="gp-regenerate" style="font-size:12px;padding:5px 12px">↺ Redo</button>' +
      '</div>' +
      '<div style="position:relative;padding-left:18px">' +
        '<div style="position:absolute;left:6px;top:8px;bottom:8px;width:2px;background:var(--forest2);opacity:0.3;border-radius:2px"></div>' +
        result.map((item, i) => {
          const isLast = i === result.length - 1
          return '<div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;position:relative">' +
            '<div style="position:absolute;left:-14px;top:4px;width:8px;height:8px;border-radius:50%;background:' + (isLast ? 'var(--forest)' : 'var(--forest2)') + ';border:2px solid white;box-shadow:0 0 0 1.5px var(--forest2)"></div>' +
            '<div style="min-width:58px;font-size:11px;font-weight:700;color:var(--forest);padding-top:2px">' + esc(item.time) + '</div>' +
            '<div style="font-size:13px;color:var(--ink);line-height:1.4;' + (isLast ? 'font-weight:700' : '') + '">' + linkifyTimers(esc(item.step)) + '</div>' +
          '</div>'
        }).join('') +
      '</div>'
  } else {
    const savedNotes = state.gamePlanModal?.notes || ''
    content =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
        '<span style="font-size:13px;font-weight:600">' + (isWholeDay ? 'Dinner' : slotLabel) + ' at:</span>' +
        '<input id="gp-dinner-time" value="' + esc(timeVal) + '" placeholder="e.g. 7:00 PM" style="flex:1;padding:8px 12px;border:1.5px solid var(--forest2);border-radius:10px;font-size:14px;font-family:inherit;text-align:center;font-weight:700" />' +
      '</div>' +
      '<div style="font-size:12px;color:var(--ink3);margin-bottom:12px;display:flex;align-items:center;gap:5px">' +
        '📅 ' + dateLabel +
      '</div>' +
      '<textarea id="gp-notes" placeholder="Anything to factor in? e.g. I can start at 4:30, skipping the potatoes tonight, kids eat at 6..." style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:13px;font-family:inherit;resize:none;min-height:72px;box-sizing:border-box;margin-bottom:12px">' + esc(savedNotes) + '</textarea>' +
      '<button class="modal-save" id="gp-generate" style="width:100%;font-size:14px;padding:14px">📋 Generate Game Plan</button>'
  }

  const hasPriorChat = chatMessages.length > 0

  return '<div class="modal-bg" id="game-plan-bg">' +
    '<div class="modal-sheet" style="max-height:85vh;overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
        '<div class="modal-title" style="margin:0">📋 ' + slotLabel + ' Game Plan</div>' +
        '<button id="gp-close" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--ink3);padding:0;line-height:1;flex-shrink:0">×</button>' +
      '</div>' +
      '<div class="modal-sub" style="margin-bottom:14px">' + dateLabel + '</div>' +
      content +
      (result ? '<div style="margin-top:16px">' +
        '<button class="modal-save" id="gp-tweak" style="background:var(--forest);color:white;width:100%;padding:12px;font-size:14px;font-weight:700;border:none;border-radius:12px;cursor:pointer;font-family:inherit">' + (hasPriorChat ? '✦ Continue Tweaking' : '✦ Tweak with AI') + '</button>' +
      '</div>' : '') +
    '</div>' +
  '</div>'
}


function renderScanPicker() {
  return '<div class="modal-bg" id="scan-picker-bg">' +
    '<div class="modal-sheet" style="text-align:center">' +
      '<div class="modal-title">Scan Recipe</div>' +
      '<div class="modal-sub">Choose how to get your recipe photo</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;margin:16px 0">' +
        '<button class="modal-save" id="scan-use-camera" style="font-size:15px;padding:14px">Take Photo</button>' +
        '<button class="modal-save" id="scan-use-library" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2);font-size:15px;padding:14px">Choose from Library</button>' +
      '</div>' +
      '<button class="modal-cancel" id="scan-picker-cancel">Cancel</button>' +
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
  const recipeTags = getTagsForNamespace('recipe')
  const tagSection = recipeTags.length > 0 ?
    '<div class="clip-field-label">Tags</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">' +
      recipeTags.map(t =>
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;background:var(--cream2);border-radius:8px;padding:8px 10px;min-width:0">' +
        '<input type="checkbox" class="paste-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--forest);flex-shrink:0;width:16px;height:16px" />' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.name) + '</span></label>'
      ).join('') +
    '</div>'
  : ''
  return '<div class="modal-bg" id="paste-modal-bg"><div class="modal-sheet">' +
    '<div class="modal-title">' + title + '</div>' +
    '<div class="modal-sub">' + sub + '</div>' +
    warning +
    '<input id="paste-name" placeholder="Recipe name" value="' + nameVal + '" />' +
    bodyFields +
    tagSection +
    '<div class="modal-btns"><button class="modal-cancel" id="paste-cancel">Cancel</button><button class="modal-save" id="paste-save">Save to Recipe Box</button></div>' +
    '</div></div>'
}

function renderShopReview() {
  const s = state.shopReview
  const itemsHtml = s.items.map(function(item, idx) {
    const pantryInfo = item.pantryQty
      ? '<div class="shop-review-have">You have: ' + esc(item.pantryQty) + '</div>'
      : '<div class="shop-review-none">Not in pantry</div>'
    const inPantry = item.inPantry
    return '<div class="shop-review-row' + (inPantry ? ' shop-review-row-pantry' : '') + '">' +
      '<input type="checkbox" class="shop-review-check" data-idx="' + idx + '" ' + (!inPantry && item.checked ? 'checked' : '') + (inPantry ? 'disabled' : '') + ' />' +
      '<div class="shop-review-info" style="flex:1;min-width:0">' +
        (inPantry
          ? '<div class="shop-review-name">' + esc(item.name) + '</div><div class="shop-review-have">Added to pantry</div>'
          : '<input class="shop-review-name-input" data-review-idx="' + idx + '" value="' + esc(item.name) + '" style="width:100%;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;margin-bottom:2px" />' +
            pantryInfo
        ) +
      '</div>' +
      (!inPantry ?
        '<button class="shop-review-pantry-btn" data-pantry-idx="' + idx + '" title="I already have this" style="flex-shrink:0">Got it</button>'
      : '') +
    '</div>'
  }).join('')
  return '<div class="modal-bg" id="shop-review-bg"><div class="modal-sheet">' +
    '<div class="modal-title">What do you need?</div>' +
    '<div class="modal-sub">' + esc(s.recipeName) + '</div>' +
    '<div class="shop-review-hint">Check items to add. Edit any name before adding. Tap "Got it" if you already have it.</div>' +
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
      '<input id="lm-portion" placeholder="How much? (e.g. 1 serving, half portion, 2 cups)" value="' + esc(m.portion || '') + '" />' +
      (recipe ?
        '<input id="lm-notes" placeholder="Any changes? (e.g. no cheese, extra chicken)" value="' + esc(m.notes || '') + '" style="margin-top:6px" />'
      : '') +
      '<div class="lm-cal-row">' +
        (estimating ?
          '<div style="flex:1;font-size:13px;color:var(--ink3);font-style:italic;padding:8px">Estimating calories...</div>'
        :
          '<input id="lm-cals" type="number" placeholder="Calories (auto-filled)" style="flex:1" value="' + (m.calories || '') + '" />' +
          '<button class="lm-estimate-btn" id="lm-estimate">Estimate</button>'
        ) +
      '</div>' +
      (m.estimateMsg ? '<div class="modal-note">' + esc(m.estimateMsg) + '</div>' : '') +
      (m.breakdown ? '<div class="log-breakdown-text" style="margin:8px 0">' + esc(m.breakdown) + '</div>' : '') +
      '<div class="modal-btns">' +
        '<button class="modal-cancel" id="lm-cancel">Cancel</button>' +
        '<button class="modal-save" id="lm-save">Add to Log</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // ── TIMER HANDLERS ──
  document.querySelectorAll('.timer-link[data-timer-seconds]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      unlockAudio()
      const seconds = parseInt(el.dataset.timerSeconds)
      const label = el.dataset.timerLabel
      startTimer(seconds, label)
    })
  })

  // Range timer — opens slider popover
  document.querySelectorAll('.timer-range-link[data-timer-low]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      unlockAudio()
      const rect = el.getBoundingClientRect()
      state.timerSlider = {
        low: parseInt(el.dataset.timerLow),
        high: parseInt(el.dataset.timerHigh),
        current: parseInt(el.dataset.timerLow), // start at low end
        label: el.dataset.timerLabel,
        anchorTop: rect.bottom,
        anchorLeft: rect.left
      }
      render()
    })
  })

  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = el.dataset.tab
      localStorage.setItem('mep_tab', state.tab)
      render()
      // Auto-scroll to today when switching to calendar tab
      if (el.dataset.tab === 'calendar') {
        setTimeout(() => {
          const todayCard = document.querySelector('.cal-day-today')
          if (todayCard) todayCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 80)
      }
    })
  })

  // Header menu
  document.getElementById('header-menu-btn')?.addEventListener('click', () => {
    state.showHeaderMenu = !state.showHeaderMenu
    render()
  })

  // Goals
  document.getElementById('goals-toggle')?.addEventListener('click', () => {
    state.showGoals = !state.showGoals
    state.showSync = false
    state.showHeaderMenu = false
    render()
  })

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

  // Filter chips — All lights up everything, individual tags toggle off
  document.querySelectorAll('.tag-filter-chip[data-filter-all]').forEach(el => {
    el.addEventListener('click', () => {
      const ns = el.dataset.filterAll
      const tags = getTagsForNamespace(ns)
      const active = state.activeTagFilters[ns]
      const allSelected = active && tags.every(t => active.has(t.name))
      if (allSelected) {
        // All were selected — clicking again clears back to default (show all, nothing lit)
        state.activeTagFilters[ns] = null
      } else {
        // Select all tags
        state.activeTagFilters[ns] = new Set(tags.map(t => t.name))
      }
      render()
    })
  })
  document.querySelectorAll('.tag-filter-chip[data-filter-tag]').forEach(el => {
    el.addEventListener('click', () => {
      const ns = el.dataset.filterNs
      const tag = el.dataset.filterTag
      if (!state.activeTagFilters[ns]) {
        // First tap from default — create a Set with just this tag
        state.activeTagFilters[ns] = new Set([tag])
      } else {
        const active = state.activeTagFilters[ns]
        if (active.has(tag)) {
          active.delete(tag)
          // If nothing left, go back to default
          if (active.size === 0) state.activeTagFilters[ns] = null
        } else {
          active.add(tag)
        }
      }
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
  document.getElementById('force-update-btn')?.addEventListener('click', async () => {
    state.showHeaderMenu = false
    const btn = document.getElementById('force-update-btn')
    if (btn) { btn.textContent = '↻ Updating...'; btn.disabled = true }
    try {
      // Unregister all service workers
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
      }
      // Clear all caches
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
    } catch(e) {}
    // Hard reload
    window.location.reload(true)
  })

  document.getElementById('sync-toggle')?.addEventListener('click', () => {
    state.showSync = !state.showSync
    state.showGoals = false
    state.showHeaderMenu = false
    render()
  })
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
    if (!newId || newId.length < 3) { alert('Please enter an Account ID (at least 3 characters)'); return; }
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
      const f = el.dataset.goal
      state.goals[f] = (f === 'weight' || f === 'age' || f === 'height_inches' || f === 'target_weight')
        ? (parseFloat(el.value) || '') : (parseInt(el.value) || 0)
      // Lock in start date when target weight is first set
      if (f === 'target_weight' && el.value && !state.goals.goal_start_date) {
        state.goals.goal_start_date = new Date().toISOString().slice(0, 10)
      }
      await db.saveGoals(state.goals)
      render()
    })
  })
  document.querySelector('select[data-goal="activity_level"]')?.addEventListener('change', async e => {
    state.goals.activity_level = e.target.value
    await db.saveGoals(state.goals)
    render()
  })
  document.getElementById('goal-start-date-input')?.addEventListener('change', async e => {
    const val = e.target.value
    if (!val) return
    state.goals.goal_start_date = val
    await db.saveGoals(state.goals)
    render()
  })
  document.querySelectorAll('[data-pace]').forEach(el => {
    el.addEventListener('click', async () => {
      state.goals.loss_pace = el.dataset.pace
      state.goals.calories = parseInt(el.dataset.calories)
      await db.saveGoals(state.goals)
      render()
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

  // Tab search handlers
  function refocusSearch(id) {
    const el = document.getElementById(id)
    if (el) { const pos = el.value.length; el.focus(); el.setSelectionRange(pos, pos) }
  }
  function addSearchHandlers(id, stateKey) {
    const el = document.getElementById(id)
    if (!el) return
    el.addEventListener('input', e => { state[stateKey] = e.target.value; render(); refocusSearch(id) })
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); render() } })
  }
  addSearchHandlers('recipe-search', 'recipeSearch')
  addSearchHandlers('pantry-search', 'pantrySearch')
  addSearchHandlers('shop-search', 'shopSearch')
  addSearchHandlers('tag-search', 'tagSearch')
  document.querySelectorAll('[data-clear-search]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.clearSearch
      if (id === 'recipe-search') state.recipeSearch = ''
      else if (id === 'pantry-search') state.pantrySearch = ''
      else if (id === 'shop-search') state.shopSearch = ''
      else if (id === 'tag-search') state.tagSearch = ''
      render()
    })
  })

  document.getElementById('scan-recipe-btn')?.addEventListener('click', () => {
    state.scanPickerOpen = true; render()
  })
  document.getElementById('scan-picker-cancel')?.addEventListener('click', () => { state.scanPickerOpen = false; render() })
  document.getElementById('scan-picker-bg')?.addEventListener('click', e => { if (e.target.id === 'scan-picker-bg') { state.scanPickerOpen = false; render() } })
  document.getElementById('scan-use-camera')?.addEventListener('click', () => {
    state.scanPickerOpen = false; render()
    const input = document.getElementById('scan-file-input')
    if (input) { input.removeAttribute('capture'); input.setAttribute('capture', 'environment'); input.click() }
  })
  document.getElementById('scan-use-library')?.addEventListener('click', () => {
    state.scanPickerOpen = false; render()
    const input = document.getElementById('scan-file-input')
    if (input) { input.removeAttribute('capture'); input.click() }
  })
  document.getElementById('scan-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]
    if (!file) return
    state.pasteModal = true
    state.shareLoading = true
    render()
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mediaType: file.type })
      })
      const recipe = await resp.json()
      if (recipe.error) throw new Error(recipe.error)
      state.shareLoading = false
      state.sharedRecipe = { ...recipe, source: 'Scanned from photo' }
      render()
    } catch (err) {
      state.shareLoading = false
      state.sharedRecipe = null
      render()
      setTimeout(() => {
        const nameEl = document.getElementById('paste-name')
        if (nameEl) nameEl.placeholder = "Could not read photo -- paste recipe manually"
      }, 50)
    }
    e.target.value = ''
  })
  document.getElementById('add-recipe-btn')?.addEventListener('click', () => { state.addRecipeModal = !state.addRecipeModal; render(); setTimeout(() => document.getElementById('r-name')?.focus(), 50) })
  document.getElementById('clip-url-btn-recipes')?.addEventListener('click', async () => {
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
      const name = document.getElementById('edit-recipe-name-' + rid)?.value?.trim()
      const ingredients = document.getElementById('edit-ingredients-' + rid)?.value?.trim()
      const instructions = document.getElementById('edit-instructions-' + rid)?.value?.trim()
      if (recipe) {
        if (name) recipe.name = name
        recipe.ingredients = ingredients
        recipe.instructions = instructions
        await db.updateRecipe(rid, { name: name || recipe.name, ingredients, instructions })
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

  document.querySelectorAll('[data-shop]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const r = state.recipes.find(x => x.id === el.dataset.shop)
      if (!r) return
      const ingLines = (r.ingredients || r.text || '').split('\n')
        .map(l => l.replace(/^[•*\-]\s*/, '').replace(/^\d+\.\s*/, '').trim()).filter(l => l.length > 2 && l.length < 120)
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
  document.querySelectorAll('.shop-review-pantry-btn').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const idx = +el.dataset.pantryIdx
      if (!state.shopReview) return
      const item = state.shopReview.items[idx]
      item.inPantry = true
      item.checked = false
      const exists = state.pantry.some(p => p.name.toLowerCase() === item.name.toLowerCase())
      if (!exists) {
        const saved = await db.addPantryItem(item.name, '')
        if (saved) state.pantry.push(saved)
      }
      render()
    })
  })
  document.querySelectorAll('.shop-review-name-input').forEach(el => {
    el.addEventListener('change', () => {
      const idx = parseInt(el.dataset.reviewIdx)
      if (state.shopReview && state.shopReview.items[idx]) {
        state.shopReview.items[idx].name = el.value.trim() || state.shopReview.items[idx].name
      }
    })
  })
  document.getElementById('shop-review-cancel')?.addEventListener('click', () => { state.shopReview = null; render() })
  document.getElementById('shop-review-bg')?.addEventListener('click', e => { if (e.target.id === 'shop-review-bg') { state.shopReview = null; render() } })
  document.getElementById('shop-review-add')?.addEventListener('click', async () => {
    if (!state.shopReview) return
    // Snapshot any edited names from inputs before saving
    document.querySelectorAll('.shop-review-name-input').forEach(el => {
      const idx = parseInt(el.dataset.reviewIdx)
      if (state.shopReview.items[idx]) {
        state.shopReview.items[idx].name = el.value.trim() || state.shopReview.items[idx].name
      }
    })
    const toAdd = state.shopReview.items.filter(i => i.checked && !i.inPantry)
    for (const item of toAdd) {
      const already = state.shopList.some(s => s.name.toLowerCase() === item.name.toLowerCase())
      if (!already) {
        const saved = await db.addShopItem(item.name, state.shopReview.recipeName)
        if (saved) state.shopList.push({ ...saved, fromRecipe: saved.from_recipe })
      }
    }
    state.shopReview = null; state.tab = 'shop'; render()
  })

  document.querySelectorAll('[data-plan-recipe]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const rid = el.dataset.planRecipe
      const today = new Date().toISOString().slice(0, 10)
      const plannedEntry = state.mealPlan.find(m => m.date === today && String(m.recipe_id) === String(rid))
      const slot = plannedEntry?.meal_slot || 'Dinner'
      const defaultTime = slot === 'Breakfast' ? '8:00 AM' : slot === 'Lunch' ? '12:30 PM' : slot === 'Snack' ? '3:30 PM' : (localStorage.getItem('mep_dinner_time') || '7:00 PM')
      const chatKey = today + '-' + slot
      const hasPriorChat = state.gamePlanChats[chatKey] && state.gamePlanChats[chatKey].length > 0
      if (hasPriorChat) {
        state.gamePlanView = 'chat'
        state.gamePlanModal = { slot, targetTime: state._lastGamePlan?.targetTime || defaultTime, date: today, recipeId: rid }
        render()
        setTimeout(() => {
          const el = document.getElementById('gp-chat-messages')
          if (el) el.scrollTop = el.scrollHeight
        }, 50)
      } else {
        state.gamePlanResult = null
        state.gamePlanLoading = false
        state.gamePlanView = 'timeline'
        state._lastGamePlan = { slot, date: today }
        state.gamePlanModal = { slot, targetTime: defaultTime, date: today, recipeId: rid }
        render()
      }
    })
  })

  // Organize tags button
  document.getElementById('organize-tags-btn')?.addEventListener('click', async () => {
    const recipeTags = state.allTags.filter(t => t.namespace === 'recipe')
    if (!recipeTags.length) return
    // Open modal in loading state, ask AI to classify
    state.tagOrganizerModal = { loading: true, tags: recipeTags }
    render()
    try {
      const tagNames = recipeTags.map(t => t.name).join(', ')
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          messages: [{ role: 'user', content: `Classify these recipe tags as either "category" (what the dish IS — ingredient, protein, cuisine type like Chicken, Pork, Pasta, Salad, Soup, Italian) or "style" (how it's made or when it's served — like Sous Vide, Weeknight, Party Ideas, Meal Prep, Quick, Slow Cooker, Grilled). Return ONLY a JSON object like: {"Pork":"category","Sous Vide":"style"}. Tags: ${tagNames}` }]
        })
      })
      const data = await resp.json()
      const text = data.content?.[0]?.text || '{}'
      const clean = text.replace(/^```json\n?|^```\n?|```$/gm, '').trim()
      const classified = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || '{}')
      // Apply AI suggestions to tags
      const updatedTags = recipeTags.map(t => ({
        ...t,
        tag_type: classified[t.name] || t.tag_type || 'category'
      }))
      state.tagOrganizerModal = { loading: false, tags: updatedTags }
    } catch(e) {
      // If AI fails just show tags with current types for manual editing
      state.tagOrganizerModal = { loading: false, tags: recipeTags }
    }
    render()
  })

  // Tag type toggle buttons in organizer
  document.querySelectorAll('.tag-type-btn[data-tag-id]').forEach(el => {
    el.addEventListener('click', () => {
      if (!state.tagOrganizerModal?.tags) return
      const id = el.dataset.tagId
      const type = el.dataset.tagType
      const tag = state.tagOrganizerModal.tags.find(t => String(t.id) === String(id))
      if (tag) { tag.tag_type = type; render() }
    })
  })

  // Save tag organizer
  document.getElementById('tag-organizer-save')?.addEventListener('click', async () => {
    if (!state.tagOrganizerModal?.tags) return
    for (const t of state.tagOrganizerModal.tags) {
      await db.updateTagType(t.id, t.tag_type || 'category')
      const existing = state.allTags.find(x => x.id === t.id)
      if (existing) existing.tag_type = t.tag_type
    }
    state.tagOrganizerModal = false
    render()
  })

  document.getElementById('tag-organizer-close')?.addEventListener('click', () => {
    state.tagOrganizerModal = false; render()
  })
  document.getElementById('tag-organizer-bg')?.addEventListener('click', e => {
    if (e.target.id === 'tag-organizer-bg') { state.tagOrganizerModal = false; render() }
  })
  document.querySelectorAll('.recipe-sort-btn[data-sort]').forEach(el => {
    el.addEventListener('click', () => { state.recipeSort = el.dataset.sort; render() })
  })

  // View toggle
  document.getElementById('view-cards-btn')?.addEventListener('click', () => { state.recipeView = 'cards'; render() })
  document.getElementById('view-list-btn')?.addEventListener('click', () => { state.recipeView = 'list'; render() })

  // List row expand/collapse
  document.querySelectorAll('[data-expand-recipe]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.expandRecipe
      state.expandedRecipe = state.expandedRecipe === id ? null : id
      render()
    })
  })

  document.getElementById('toggle-archived-btn')?.addEventListener('click', () => {
    state.showArchived = !state.showArchived; render()
  })

  document.querySelectorAll('[data-archive-recipe]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.archiveRecipe
      const r = state.recipes.find(r => r.id === id)
      if (r) { r.archived = true; await db.archiveRecipe(id, true); render() }
    })
  })

  document.querySelectorAll('[data-restore-recipe]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.restoreRecipe
      const r = state.recipes.find(r => r.id === id)
      if (r) { r.archived = false; await db.archiveRecipe(id, false); render() }
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
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const r = state.recipes.find(x => x.id === el.dataset.ask)
      if (!r) return
      state.chatRecipeContext = r
      state.tab = 'chat'
      localStorage.setItem('mep_tab', 'chat')
      // Load persisted chat from Supabase if not already in memory
      if (!state.recipeChatMessages[r.id] || state.recipeChatMessages[r.id].length === 0) {
        const saved = await db.fetchRecipeChat(r.id)
        if (saved && saved.length > 0) state.recipeChatMessages[r.id] = saved
      }
      render()
      setTimeout(() => document.getElementById('chat-input')?.focus(), 100)
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

  // ── SHOPPING LIST EVENTS ──

  // Check off item (strike-through, don't delete)
  document.querySelectorAll('[data-check]').forEach(el => {
    el.addEventListener('click', async () => {
      const item = state.shopList.find(x => x.id === el.dataset.check)
      if (!item) return
      if (item.have) {
        // Tap again to uncheck
        item.have = false
        item.checked_at = null
        await db.updateShopItem(item.id, false)
      } else {
        item.have = true
        item.checked_at = Date.now()
        await db.updateShopItem(item.id, true)
      }
      render()
    })
  })

  document.querySelectorAll('[data-uncheck]').forEach(el => {
    el.addEventListener('click', async () => {
      const item = state.shopList.find(x => x.id === el.dataset.uncheck)
      if (item) { item.have = false; item.checked_at = null; await db.updateShopItem(item.id, false); render() }
    })
  })

  document.querySelectorAll('[data-shop-del]').forEach(el => {
    el.addEventListener('click', async () => {
      state.shopList = state.shopList.filter(x => x.id !== el.dataset.shopDel)
      await db.deleteShopItem(el.dataset.shopDel); render()
    })
  })

  document.getElementById('shop-got-it')?.addEventListener('click', async () => {
    const now = Date.now()
    state.shopList.forEach(i => {
      if (!i.have) { i.have = true; i.checked_at = now }
    })
    await db.markAllGotIt(state.shopList, state.pantry)
    const newPantry = await db.fetchPantry()
    state.pantry = newPantry
    render()
  })

  // Clear only checked items
  document.getElementById('shop-clear-checked')?.addEventListener('click', async () => {
    const checkedIds = state.shopList.filter(i => i.have).map(i => i.id)
    state.shopList = state.shopList.filter(i => !i.have)
    for (const id of checkedIds) await db.deleteShopItem(id)
    render()
  })

  // Remove all items in cart (same as clear checked)
  document.getElementById('shop-clear-cart')?.addEventListener('click', async () => {
    const checkedIds = state.shopList.filter(i => i.have).map(i => i.id)
    state.shopList = state.shopList.filter(i => !i.have)
    for (const id of checkedIds) await db.deleteShopItem(id)
    render()
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
  // Weight log
  document.getElementById('log-weight-btn')?.addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('log-weight-input')?.value)
    if (!val || isNaN(val)) return
    const isViewingToday = (state.logDayOffset || 0) === 0
    const dateStr = isViewingToday ? new Date().toLocaleDateString('sv') : state._viewedDateStr

    // Check if there's already an entry for this day
    const existing = (state.weightLog || []).find(e => new Date(e.logged_at).toLocaleDateString('sv') === dateStr)

    if (existing) {
      // Update existing entry
      const saved = await db.updateWeightEntry(existing.id, val)
      if (saved) {
        existing.weight = val
        state.weightLog.sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at))
      }
    } else {
      // Add new entry
      const entryDateStr = isViewingToday ? null : state._viewedDateStr
      const saved = await db.addWeightEntry(val, '', entryDateStr)
      if (saved) {
        state.weightLog = state.weightLog || []
        state.weightLog.push(saved)
        state.weightLog.sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at))
      }
    }
    render()
  })
  document.getElementById('log-weight-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('log-weight-btn')?.click() } })
  document.querySelectorAll('[data-weight-del]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.weightDel
      state.weightLog = (state.weightLog || []).filter(x => String(x.id) !== String(id))
      await db.deleteWeightEntry(id)
      render()
    })
  })
  document.getElementById('log-exercise-btn')?.addEventListener('click', async () => {
    const activity = document.getElementById('log-exercise')?.value?.trim()
    if (!activity) return
    const btn = document.getElementById('log-exercise-btn')
    if (btn) { btn.textContent = '...'; btn.disabled = true }
    const weight = state.goals.weight || 155
    const age = state.goals.age || 35
    const { calories, breakdown } = await estimateCaloriesAI(
      'Calories BURNED (not consumed) during: "' + activity + '" for a person weighing ' + weight + ' lbs, age ' + age + '. ' +
      'Reply with ONLY:\nCALORIES: [number]\nBREAKDOWN: [brief explanation]\nNo other text.'
    )
    const isExToday = (state.logDayOffset || 0) === 0
    const exDateStr = isExToday ? null : state._viewedDateStr
    const saved = await db.addExerciseEntry(activity, calories, breakdown, exDateStr)
    if (saved) {
      saved.breakdown = breakdown
      if (isExToday) {
        state.exerciseLog = state.exerciseLog || []
        state.exerciseLog.push(saved)
      } else {
        state.viewedDayExercise = state.viewedDayExercise || []
        state.viewedDayExercise.push(saved)
      }
    }
    const input = document.getElementById('log-exercise')
    if (input) input.value = ''
    if (btn) { btn.textContent = '+ Add'; btn.disabled = false }
    render()
  })
  document.getElementById('log-exercise')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('log-exercise-btn')?.click() } })

  // Exercise ? breakdown
  document.querySelectorAll('[data-ex-breakdown-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const id = 'ex-' + el.dataset.exBreakdownId
      state.logBreakdownId = state.logBreakdownId === id ? null : id
      render()
    })
  })

  // Exercise delete
  document.querySelectorAll('[data-ex-del]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.exDel
      state.exerciseLog = (state.exerciseLog || []).filter(x => String(x.id) !== String(id))
      await db.deleteExerciseEntry(id)
      render()
    })
  })
  async function estimatePrepTime(recipe) {
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content:
          'Analyze this recipe and return ONLY a JSON object with prep time details. No other text, no markdown, no backticks.\n\n' +
          'Recipe: ' + recipe.name + '\n\nIngredients:\n' + (recipe.ingredients||'') + '\n\nInstructions:\n' + (recipe.instructions||'') +
          '\n\nReturn this exact JSON structure:\n{"active_min":25,"passive_min":0,"difficulty":"Medium","equipment":["skillet","tongs"],"multitask":"what you can do while something cooks","make_ahead":"what can be prepped ahead and how far","quick_version":"fastest shortcut to reduce time"}'
        }]
      })
    })
    const data = await resp.json()
    const text = data.content?.[0]?.text?.trim() || ''
    return JSON.parse(text)
  } catch(e) { return null }
}

async function saveRecipePrepTime(recipeId, prepTime) {
  await db.updateRecipe(recipeId, { prep_time: prepTime })
}

async function estimateCaloriesAI(description) {
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content:
            'You are a precise nutrition calculator using USDA database values. Estimate calories for: "' + description + '"\n\n' +
            'Rules:\n' +
            '- Use accurate USDA/nutrition database values, not rounded estimates\n' +
            '- For single items (1 shrimp, 1 egg, 1 slice), use the actual per-item calorie count\n' +
            '- Do NOT round up aggressively — a single large shrimp is ~7 kcal, not 30\n' +
            '- If quantity is ambiguous, assume a typical single serving\n\n' +
            'Reply with ONLY this format:\nCALORIES: [number]\nBREAKDOWN: [brief per-item breakdown with actual values]\n\nNo other text.'
          }]
        })
      })
      const data = await resp.json()
      const text = data.content?.[0]?.text || ''
      const calMatch = text.match(/CALORIES:\s*(\d+)/i)
      const breakdownMatch = text.match(/BREAKDOWN:\s*(.+)/i)
      return {
        calories: calMatch ? parseInt(calMatch[1]) : 0,
        breakdown: breakdownMatch ? breakdownMatch[1].trim() : ''
      }
    } catch(e) { return { calories: 0, breakdown: '' } }
  }

  document.getElementById('log-add-btn')?.addEventListener('click', async () => {
    const food = document.getElementById('log-food')?.value?.trim()
    if (!food) return
    const btn = document.getElementById('log-add-btn')
    if (btn) { btn.textContent = '...'; btn.disabled = true }
    const { calories, breakdown } = await estimateCaloriesAI(food)
    const isToday = (state.logDayOffset || 0) === 0
    const dateStr = isToday ? null : state._viewedDateStr
    const saved = await db.addLogEntry(food, calories, null, dateStr)
    if (saved) {
      saved.breakdown = breakdown
      if (isToday) {
        state.log.push(saved)
      } else {
        state.viewedDayLog = state.viewedDayLog || []
        state.viewedDayLog.push(saved)
      }
    }
    const input = document.getElementById('log-food')
    if (input) input.value = ''
    if (btn) { btn.textContent = '+ Add'; btn.disabled = false }
    render()
  })
  document.getElementById('log-food')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('log-add-btn')?.click() } })

  // Log day navigation
  document.getElementById('log-prev-day')?.addEventListener('click', async () => {
    state.logDayOffset = (state.logDayOffset || 0) - 1
    const now = new Date()
    const d = new Date(now)
    d.setDate(now.getDate() + state.logDayOffset)
    const dateStr = d.toLocaleDateString('sv')
    state.viewedDayLog = await db.fetchLogForDate(dateStr)
    state.viewedDayExercise = await db.fetchExerciseForDate(dateStr)
    render()
  })
  document.getElementById('log-next-day')?.addEventListener('click', async () => {
    if ((state.logDayOffset || 0) >= 0) return
    state.logDayOffset = (state.logDayOffset || 0) + 1
    if (state.logDayOffset === 0) {
      state.viewedDayLog = null
      state.viewedDayExercise = null
    } else {
      const now = new Date()
      const d = new Date(now)
      d.setDate(now.getDate() + state.logDayOffset)
      const dateStr = d.toLocaleDateString('sv')
      state.viewedDayLog = await db.fetchLogForDate(dateStr)
      state.viewedDayExercise = await db.fetchExerciseForDate(dateStr)
    }
    render()
  })

  // Prep time — estimate button
  document.querySelectorAll('[data-estimate-prep]').forEach(el => {
    el.addEventListener('click', async () => {
      const rid = el.dataset.estimatePrep
      const recipe = state.recipes.find(r => String(r.id) === String(rid))
      if (!recipe) return
      state.estimatingPrepId = rid; render()
      const pt = await estimatePrepTime(recipe)
      if (pt) {
        recipe.prepTime = pt
        await saveRecipePrepTime(rid, pt)
      }
      state.estimatingPrepId = null; render()
    })
  })

  // Prep time — refresh button
  document.querySelectorAll('[data-refresh-prep]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const rid = el.dataset.refreshPrep
      const recipe = state.recipes.find(r => String(r.id) === String(rid))
      if (!recipe) return
      state.refreshingPrepId = rid; render()
      const pt = await estimatePrepTime(recipe)
      if (pt) {
        recipe.prepTime = pt
        await saveRecipePrepTime(rid, pt)
      }
      state.refreshingPrepId = null; render()
    })
  })
  document.querySelectorAll('.scale-btn[data-scale]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const rid = el.dataset.recipeId
      const scale = el.dataset.scale
      const recipe = state.recipes.find(r => String(r.id) === String(rid))
      if (!recipe || !recipe.ingredients) return
      state.scaleModal = { recipeId: rid, label: scale, loading: true, ingredients: '' }
      render()
      try {
        const multiplier = scale === '½x' ? '0.5' : scale === '2x' ? '2' : '3'
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{ role: 'user', content:
              'Scale these recipe ingredients by ' + multiplier + 'x. Return ONLY the scaled ingredient list, one per line, with updated amounts. No extra text, no explanation.\n\nIngredients:\n' + recipe.ingredients
            }]
          })
        })
        const data = await resp.json()
        const scaled = data.content?.[0]?.text?.trim() || ''
        state.scaleModal = { recipeId: rid, label: scale, loading: false, ingredients: scaled }
      } catch(e) {
        state.scaleModal = { recipeId: rid, label: scale, loading: false, ingredients: 'Error scaling — try again.' }
      }
      render()
    })
  })
  document.querySelectorAll('[data-close-scale]').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); state.scaleModal = null; render() })
  })
  document.querySelectorAll('[data-save-scaled]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      if (!state.scaleModal) return
      const rid = el.dataset.saveScaled
      const recipe = state.recipes.find(r => String(r.id) === String(rid))
      if (!recipe) return
      const name = recipe.name + ' (' + state.scaleModal.label + ')'
      const saved = await db.saveRecipe({ name, ingredients: state.scaleModal.ingredients, instructions: recipe.instructions || '', notes: '', clippedFrom: '', tags: recipe.tags || [] })
      if (saved) state.recipes.unshift(normalizeRecipe(saved))
      state.scaleModal = null
      render()
    })
  })
  document.querySelectorAll('[data-edit-log]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.editingLogId = el.dataset.editLog
      render()
      setTimeout(() => document.getElementById('edit-log-food-' + el.dataset.editLog)?.focus(), 50)
    })
  })
  document.querySelectorAll('[data-save-log]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.saveLog
      const entry = state.log.find(x => x.id === id)
      if (!entry) return
      const food = document.getElementById('edit-log-food-' + id)?.value?.trim()
      const cals = parseInt(document.getElementById('edit-log-cals-' + id)?.value) || 0
      if (!food) return
      entry.food = food
      entry.calories = cals
      await db.updateLogEntry(id, { food, calories: cals })
      state.editingLogId = null
      render()
    })
  })
  document.querySelectorAll('[data-cancel-log]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      state.editingLogId = null
      render()
    })
  })
  document.querySelectorAll('[data-breakdown-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const id = el.dataset.breakdownId
      state.logBreakdownId = state.logBreakdownId === id ? null : id
      render()
    })
  })

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

  // Estimate button in log modal
  document.getElementById('lm-estimate')?.addEventListener('click', async () => {
    if (!state.logModal) return
    const portion = document.getElementById('lm-portion')?.value?.trim()
    const notes = document.getElementById('lm-notes')?.value?.trim()
    const recipe = state.logModal.recipeId ? state.recipes.find(r => String(r.id) === String(state.logModal.recipeId)) : null
    state.logModal = { ...state.logModal, portion, notes, estimating: true }
    render()
    let description = ''
    if (recipe) {
      description = (portion || '1 serving') + ' of ' + recipe.name
      if (notes) description += ', modifications: ' + notes
      description += '\nIngredients: ' + (recipe.ingredients || '')
    } else {
      description = portion || state.logModal.recipeName
    }
    const { calories, breakdown } = await estimateCaloriesAI(description)
    state.logModal = { ...state.logModal, estimating: false, calories, breakdown,
      estimateMsg: 'Estimated ' + calories + ' kcal. You can adjust before saving.' }
    render()
    document.getElementById('lm-cals')?.focus()
  })

  document.getElementById('log-modal-bg')?.addEventListener('click', e => { if (e.target.id === 'log-modal-bg') { state.logModal = null; render() } })

  // Dismiss recipe search on outside tap
  document.getElementById('log-tab-content')?.addEventListener('click', e => {
    if (!e.target.closest('.log-search-wrap') && state.logSearch) {
      state.logSearch = ''; render()
    }
  })

  document.getElementById('lm-save')?.addEventListener('click', async () => {
    const portionEl = document.getElementById('lm-portion')
    const calsEl = document.getElementById('lm-cals')
    const notesEl = document.getElementById('lm-notes')
    const portion = portionEl?.value?.trim()
    const cals = parseInt(calsEl?.value) || state.logModal?.calories || 0
    const notes = notesEl?.value?.trim()
    if (!portion) {
      if (portionEl) portionEl.placeholder = 'Please enter portion!'
      portionEl?.focus()
      return
    }
    let food = (state.logModal?.recipeName || 'Food') + ' (' + portion + ')'
    if (notes) food += ' — ' + notes
    const saved = await db.addLogEntry(food, cals)
    if (saved) {
      if (state.logModal?.recipeId) saved.recipe_id = state.logModal.recipeId
      saved.breakdown = state.logModal?.breakdown || ''
      state.log.push(saved)
    }
    state.logModal = null; state.tab = 'log'; render()
  })

  // Paste modal
  document.getElementById('paste-btn')?.addEventListener('click', () => { state.pasteModal = true; state.showHeaderMenu = false; render(); setTimeout(() => document.getElementById('paste-name')?.focus(), 50) })

  // Clip URL modal
  document.getElementById('clip-url-btn')?.addEventListener('click', async () => {
    state.clipUrlModal = true; state.showHeaderMenu = false; render()
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
      const tags = item.tags || []
      const saved = await db.addShopItem(item.name, 'Pantry', tags)
      if (saved) state.shopList.push({ ...saved, fromRecipe: 'Pantry', tags })
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
  // Move list -> pantry (also moves to cart/crossed out)
  document.querySelectorAll('[data-move-to-pantry]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.moveToPantry
      const item = state.shopList.find(i => String(i.id) === String(id))
      if (!item) return
      const tags = item.tags || []
      // Add to pantry
      const exists = state.pantry.some(p => p.name.toLowerCase() === item.name.toLowerCase())
      if (!exists) {
        const saved = await db.addPantryItem(item.name, '', tags)
        if (saved) state.pantry.push({ ...saved, tags })
      }
      // Move to cart (check it off) rather than deleting
      item.have = true
      item.checked_at = Date.now()
      await db.updateShopItem(id, true)
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
    const tags = Array.from(document.querySelectorAll('.paste-tag-check:checked')).map(el => el.dataset.tag)
    const clippedFrom = state.sharedRecipe?.url || ''
    const saved = await db.saveRecipe({ name, ingredients, instructions, notes: '', clippedFrom, tags })
    if (saved) {
      const recipe = normalizeRecipe(saved)
      if (tags.length) await db.updateRecipeTags(recipe.id, tags)
      state.recipes.unshift(recipe)
      // Auto-estimate prep time in background
      estimatePrepTime(recipe).then(pt => {
        if (pt) {
          recipe.prepTime = pt
          saveRecipePrepTime(recipe.id, pt).then(() => render())
        }
      })
    }
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
        const rect = el.getBoundingClientRect()
        const pickerHeight = 220 // estimated picker height
        const spaceBelow = window.innerHeight - rect.bottom
        const flipUp = spaceBelow < pickerHeight && rect.top > pickerHeight
        state.tagPickerPos = {
          top: flipUp ? rect.top - pickerHeight - 4 : rect.bottom + 6,
          left: Math.min(rect.left, window.innerWidth - 220),
          flipUp
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
    const el = document.getElementById('cal-search-input')
    if (el) { const p = el.value.length; el.focus(); el.setSelectionRange(p, p) }
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
        .map(l => l.replace(/^[•*\-]\s*/, '').replace(/^\d+\.\s*/, '').trim())
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
    const el = document.getElementById('log-search')
    if (el) { const p = el.value.length; el.focus(); el.setSelectionRange(p, p) }
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
      state.expandedRecipe = String(el.dataset.goRecipe)
      render()
      // Scroll to the expanded recipe card
      setTimeout(() => {
        const card = document.querySelector('[data-rid="' + el.dataset.goRecipe + '"]')
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
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


  // ── GAME PLAN HANDLERS ──
  document.querySelectorAll('.cal-game-plan-btn[data-game-plan-slot]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      const slot = el.dataset.gamePlanSlot
      const targetTime = el.dataset.gamePlanTime
      const date = el.dataset.gamePlanDate
      const recipeId = el.dataset.gamePlanRid
      const chatKey = date + '-' + slot
      const hasPriorChat = state.gamePlanChats[chatKey] && state.gamePlanChats[chatKey].length > 0
      const hasPriorResult = state._lastGamePlan?.slot === slot && state._lastGamePlan?.date === date && state.gamePlanResult

      if (hasPriorChat) {
        // Has a saved chat — go straight to it
        state.gamePlanView = 'chat'
        state.gamePlanModal = { slot, targetTime: state._lastGamePlan?.targetTime || targetTime, date, recipeId }
        render()
        setTimeout(() => {
          const el = document.getElementById('gp-chat-messages')
          if (el) el.scrollTop = el.scrollHeight
        }, 50)
      } else {
        // No prior chat — show the generate screen
        state.gamePlanResult = null
        state.gamePlanLoading = false
        state.gamePlanView = 'timeline'
        state._lastGamePlan = { slot, date }
        state.gamePlanModal = { slot, targetTime, date, recipeId }
        render()
      }
    })
  })
  document.getElementById('gp-tweak')?.addEventListener('click', () => {
    const { slot, targetTime } = state.gamePlanModal || {}
    const result = state.gamePlanResult
    if (!result) return
    const chatKey = gpChatKey()
    // If no prior chat, seed it with the timeline as the opening assistant message
    if (!state.gamePlanChats[chatKey] || state.gamePlanChats[chatKey].length === 0) {
      const slotLabel = slot === 'Day' ? 'whole day' : (slot || 'meal')
      const timelineText = result.map(item => item.time + ' — ' + item.step).join('\n')
      state.gamePlanChats[chatKey] = [{
        role: 'assistant',
        content: 'Here\'s your ' + slotLabel + ' cooking timeline (dinner at ' + (targetTime || '7:00 PM') + '):\n\n' + timelineText + '\n\nWhat tweaks would you like to make?'
      }]
    }
    state.gamePlanView = 'chat'
    render()
    setTimeout(() => {
      const el = document.getElementById('gp-chat-messages')
      if (el) el.scrollTop = el.scrollHeight
      document.getElementById('gp-chat-input')?.focus()
    }, 50)
  })

  document.getElementById('gp-start-over')?.addEventListener('click', () => {
    const { date, slot } = state.gamePlanModal || {}
    const chatKey = (date || 'today') + '-' + (slot || 'Dinner')
    state.gamePlanChats[chatKey] = []
    state.gamePlanResult = null
    state.gamePlanView = 'timeline'
    state._lastGamePlan = null
    render()
  })

  document.getElementById('gp-back-to-timeline')?.addEventListener('click', () => {
    state.gamePlanView = 'timeline'
    render()
  })

  // Send message in game plan chat
  async function sendGpChatMessage(text) {
    if (!text.trim() || state.gamePlanChatLoading) return
    const chatKey = gpChatKey()
    if (!state.gamePlanChats[chatKey]) state.gamePlanChats[chatKey] = []
    state.gamePlanChats[chatKey].push({ role: 'user', content: text })
    state.gamePlanChatLoading = true
    render()
    setTimeout(() => {
      const el = document.getElementById('gp-chat-messages')
      if (el) el.scrollTop = el.scrollHeight
    }, 50)
    try {
      const { slot, targetTime } = state.gamePlanModal || {}
      const system = 'You are a cooking timeline assistant. The user has a meal plan and you are helping them adjust their cooking timeline. Be specific and practical. Keep responses concise. Reference actual times and steps from the timeline.'
      const messages = state.gamePlanChats[chatKey].map(m => ({ role: m.role, content: m.content }))
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, system })
      })
      const data = await resp.json()
      const reply = data.content?.[0]?.text || 'Sorry, something went wrong.'
      state.gamePlanChats[chatKey].push({ role: 'assistant', content: reply })
    } catch(e) {
      state.gamePlanChats[chatKey].push({ role: 'assistant', content: 'Something went wrong — try again.' })
    }
    state.gamePlanChatLoading = false
    render()
    setTimeout(() => {
      const el = document.getElementById('gp-chat-messages')
      if (el) el.scrollTop = el.scrollHeight
    }, 50)
    // Auto-save to Supabase after each message
    saveGamePlanToDb()
  }

  document.getElementById('gp-chat-send')?.addEventListener('click', () => {
    const input = document.getElementById('gp-chat-input')
    const text = input?.value?.trim()
    if (text) { input.value = ''; sendGpChatMessage(text) }
  })
  document.getElementById('gp-chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = e.target.value?.trim()
      if (text) { e.target.value = ''; sendGpChatMessage(text) }
    }
  })
  document.getElementById('gp-close')?.addEventListener('click', () => {
    state.gamePlanModal = { ...state.gamePlanModal, _open: false }
    state.gamePlanModal = false
    render()
  })
  document.getElementById('game-plan-bg')?.addEventListener('click', e => {
    if (e.target.id === 'game-plan-bg') { state.gamePlanModal = false; render() }
  })
  document.getElementById('gp-generate')?.addEventListener('click', async () => {
    const timeVal = document.getElementById('gp-dinner-time')?.value?.trim()
    const notes = document.getElementById('gp-notes')?.value?.trim() || ''
    const { slot, date, recipeId } = state.gamePlanModal
    if (slot === 'Dinner' || slot === 'Day') localStorage.setItem('mep_dinner_time', timeVal)
    state.gamePlanModal = { ...state.gamePlanModal, targetTime: timeVal, notes }
    state._lastGamePlan = { slot, date, targetTime: timeVal }
    state.gamePlanLoading = true
    state.gamePlanResult = null
    render()
    const result = await generateGamePlan(slot, timeVal, date, recipeId, notes)
    state.gamePlanLoading = false
    state.gamePlanResult = result || [{ time: '?', step: 'Could not generate timeline — check your connection and try again.' }]
    // Seed the chat thread and go straight to it
    const chatKey = date + '-' + slot
    const slotLabel = slot === 'Day' ? 'whole day' : slot
    const timelineText = (state.gamePlanResult || []).map(item => item.time + ' — ' + item.step).join('\n')
    const seedMessages = []
    if (notes) seedMessages.push({ role: 'user', content: notes })
    seedMessages.push({ role: 'assistant', content: 'Here\'s your ' + slotLabel + ' plan (dinner at ' + timeVal + '):\n\n' + timelineText + '\n\nWhat tweaks would you like to make?' })
    state.gamePlanChats[chatKey] = seedMessages
    state.gamePlanView = 'chat'
    saveGamePlanToDb()
    render()
    setTimeout(() => {
      const el = document.getElementById('gp-chat-messages')
      if (el) el.scrollTop = el.scrollHeight
      document.getElementById('gp-chat-input')?.focus()
    }, 50)
  })
  document.getElementById('gp-regenerate')?.addEventListener('click', async () => {
    const timeVal = document.getElementById('gp-dinner-time')?.value?.trim() || state.gamePlanModal?.targetTime
    const { slot, date, recipeId, notes } = state.gamePlanModal
    if (slot === 'Dinner' || slot === 'Day') localStorage.setItem('mep_dinner_time', timeVal)
    state.gamePlanModal = { ...state.gamePlanModal, targetTime: timeVal }
    state._lastGamePlan = { slot, date, targetTime: timeVal }
    state.gamePlanLoading = true
    state.gamePlanResult = null
    render()
    const result = await generateGamePlan(slot, timeVal, date, recipeId, notes)
    state.gamePlanLoading = false
    state.gamePlanResult = result || [{ time: '?', step: 'Could not generate timeline — check your connection and try again.' }]
    // Re-seed chat thread with new timeline
    const chatKey = date + '-' + slot
    const slotLabel = slot === 'Day' ? 'whole day' : slot
    const timelineText = (state.gamePlanResult || []).map(item => item.time + ' — ' + item.step).join('\n')
    const seedMessages = []
    if (notes) seedMessages.push({ role: 'user', content: notes })
    seedMessages.push({ role: 'assistant', content: 'Here\'s your updated ' + slotLabel + ' plan (dinner at ' + timeVal + '):\n\n' + timelineText + '\n\nWhat tweaks would you like to make?' })
    state.gamePlanChats[chatKey] = seedMessages
    state.gamePlanView = 'chat'
    saveGamePlanToDb()
    render()
    setTimeout(() => {
      const el = document.getElementById('gp-chat-messages')
      if (el) el.scrollTop = el.scrollHeight
    }, 50)
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
  document.getElementById('chat-clear-context')?.addEventListener('click', () => {
    state.chatRecipeContext = null; render()
  })

  // Back arrow and recipe name link — both jump back to the recipe card
  const goToRecipeFromChat = () => {
    if (!state.chatRecipeContext) return
    const rid = String(state.chatRecipeContext.id)
    state.tab = 'recipes'
    state.expandedRecipe = rid
    localStorage.setItem('mep_tab', 'recipes')
    render()
    setTimeout(() => {
      const card = document.querySelector('[data-rid="' + rid + '"]')
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }
  document.getElementById('chat-back-to-recipe')?.addEventListener('click', goToRecipeFromChat)
  document.getElementById('chat-go-to-recipe')?.addEventListener('click', goToRecipeFromChat)
  document.getElementById('chat-clear')?.addEventListener('click', () => {
    const rid = state.chatRecipeContext?.id
    if (rid) {
      state.recipeChatMessages[rid] = []
      db.saveRecipeChat(rid, [])
    } else {
      state.chatMessages = []
    }
    render()
  })

  // Tappable recipe links inside AI chat bubbles
  document.querySelectorAll('.chat-recipe-link[data-go-recipe]').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = 'recipes'
      state.expandedRecipe = String(el.dataset.goRecipe)
      localStorage.setItem('mep_tab', 'recipes')
      render()
      setTimeout(() => {
        const card = document.querySelector('[data-rid="' + el.dataset.goRecipe + '"]')
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    })
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

    // Purge checked items older than 1 hour on tab focus too
    purgeStaleCheckedItems()

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
