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
  scanPickerOpen: false,
  logSearch: '',        // search query in log tab
  logTagFilter: null,
  logSearchFocused: false,
  logBreakdownId: null,
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
    const systemPrompt = 'You are a personal food and meal planning coach for this user. You know their recipes, pantry, eating habits and goals intimately. Be warm, specific, and actionable. Reference their actual recipes and patterns by name when relevant. Keep responses concise and practical.\n\nWhen asked to build a grocery list: look at THIS WEEK\'S MEAL PLAN to see what recipes are planned, then check each recipe\'s ingredients against the PANTRY (skip anything already there) and CURRENT SHOPPING LIST (skip anything already on it), and suggest only what\'s missing. List items grouped by recipe.\n\n' + context + agentCtx

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
  const [recipes, pantry, shopList, log, goals, allTags, mealPlan, historyLog, exerciseLog, weightLog] = await Promise.all([
    db.fetchRecipes(), db.fetchPantry(), db.fetchShopList(), db.fetchLog(), db.fetchGoals(), db.fetchTags(),
    db.fetchMealPlan(weekDates[0], weekDates[6]), db.fetchFullLog(90), db.fetchExerciseLog(), db.fetchWeightLog()
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
    </div>
  `
  bindEvents()
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
  const tags = getTagsForNamespace(namespace)
  if (!tags.length) return ''
  const activeTag = state.activeTagFilterNs === namespace ? state.activeTagFilter : null
  return '<div class="tag-filter-wrap">' +
    '<div class="tag-filter-row">' +
      '<button class="tag-filter-chip ' + (!activeTag ? 'active' : '') + '" data-filter-tag="" data-filter-ns="' + namespace + '">All</button>' +
      tags.map(t => '<button class="tag-filter-chip ' + (activeTag===t.name ? 'active' : '') + '" data-filter-tag="' + esc(t.name) + '" data-filter-ns="' + namespace + '">' + esc(t.name) + '</button>').join('') +
      '<button class="tag-filter-chip ' + (activeTag==='__untagged__' ? 'active' : '') + '" data-filter-tag="__untagged__" data-filter-ns="' + namespace + '">Untagged</button>' +
    '</div>' +
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
      '<button class="ra-btn ra-ask" data-ask="' + r.id + '">Ask AI</button>' +
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
  let filtered = (state.activeTagFilter && state.activeTagFilterNs === 'recipe') ? state.recipes.filter(r => state.activeTagFilter === '__untagged__' ? !(r.tags||[]).length : (r.tags||[]).includes(state.activeTagFilter)) : state.recipes
  if (search) filtered = filtered.filter(r => r.name.toLowerCase().includes(search) || (r.ingredients||'').toLowerCase().includes(search))
  return `
    <div class="tab-content">
      <div class="section-header">
        <div class="section-title">My Recipe Box</div>
        <div style="display:flex;gap:6px">
          <button class="add-btn" id="scan-recipe-btn" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">Scan</button>
          <button class="add-btn" id="clip-url-btn-recipes" style="background:var(--sage4);color:var(--forest);border:1.5px solid var(--forest2)">Clip URL</button>
          <button class="add-btn" id="add-recipe-btn">+ Add</button>
        </div>
      </div>
      <input type="file" id="scan-file-input" accept="image/*" capture="environment" style="display:none" />
      ${renderSearchBar('recipe-search', state.recipeSearch || '', 'Search recipes...')}
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
  const search = (state.pantrySearch || '').toLowerCase()
  const filtered = state.pantry.filter(item =>
    (!activeTag || (activeTag === '__untagged__' ? !(item.tags||[]).length : (item.tags||[]).includes(activeTag))) &&
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
  const search = (state.shopSearch || '').toLowerCase()
  const need = state.shopList.filter(i =>
    !i.have &&
    (!activeTag || (activeTag === '__untagged__' ? !(i.tags||[]).length : (i.tags||[]).includes(activeTag))) &&
    (!search || i.name.toLowerCase().includes(search))
  )

  return '<div class="tab-content">' +
    '<div class="shop-header">' +
      '<div class="section-title">Shopping List</div>' +
      (state.shopList.length > 0 ? '<div style="display:flex;gap:6px"><button class="icon-btn" id="shop-copy-btn">Copy</button><button class="clear-pantry-btn" id="shop-clear">Clear</button></div>' : '') +
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
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">' +
      recipeTags.map(t =>
        '<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:var(--cream2);border-radius:8px;padding:4px 8px">' +
        '<input type="checkbox" class="paste-tag-check" data-tag="' + esc(t.name) + '" style="accent-color:var(--forest)" />' +
        esc(t.name) + '</label>'
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
      '<div class="shop-review-info">' +
        '<div class="shop-review-name">' + esc(item.name) + '</div>' +
        (inPantry ? '<div class="shop-review-have">Added to pantry</div>' : pantryInfo) +
      '</div>' +
      (!inPantry ?
        '<button class="shop-review-pantry-btn" data-pantry-idx="' + idx + '" title="I already have this">Got it</button>'
      : '') +
    '</div>'
  }).join('')
  return '<div class="modal-bg" id="shop-review-bg"><div class="modal-sheet">' +
    '<div class="modal-title">What do you need?</div>' +
    '<div class="modal-sub">' + esc(s.recipeName) + '</div>' +
    '<div class="shop-review-hint">Check items to add to your list. Tap "Got it" if you already have it.</div>' +
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
  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(el => {
    el.addEventListener('click', () => { state.tab = el.dataset.tab; localStorage.setItem('mep_tab', state.tab); render() })
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
  // "Got it" — mark as in pantry, uncheck from list, add to pantry
  document.querySelectorAll('.shop-review-pantry-btn').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const idx = +el.dataset.pantryIdx
      if (!state.shopReview) return
      const item = state.shopReview.items[idx]
      item.inPantry = true
      item.checked = false
      // Add to pantry if not already there
      const exists = state.pantry.some(p => p.name.toLowerCase() === item.name.toLowerCase())
      if (!exists) {
        const saved = await db.addPantryItem(item.name, '')
        if (saved) state.pantry.push(saved)
      }
      render()
    })
  })
  document.getElementById('shop-review-cancel')?.addEventListener('click', () => { state.shopReview = null; render() })
  document.getElementById('shop-review-bg')?.addEventListener('click', e => { if (e.target.id === 'shop-review-bg') { state.shopReview = null; render() } })
  document.getElementById('shop-review-add')?.addEventListener('click', async () => {
    if (!state.shopReview) return
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
            'Estimate the calories for: "' + description + '"\n\n' +
            'Reply with ONLY this format:\nCALORIES: [number]\nBREAKDOWN: [brief per-item breakdown, e.g. "Cheerios 1/2 cup: 55 cal, Whole milk 1/2 cup: 75 cal"]\n\nNo other text.'
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
  // Move list -> pantry
  document.querySelectorAll('[data-move-to-pantry]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation()
      const id = el.dataset.moveToPantry
      const item = state.shopList.find(i => String(i.id) === String(id))
      if (!item) return
      const tags = item.tags || []
      const saved = await db.addPantryItem(item.name, '', tags)
      if (saved) state.pantry.push({ ...saved, tags })
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
