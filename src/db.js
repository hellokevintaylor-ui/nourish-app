import { supabase, getUserId } from './supabase.js'

const uid = () => getUserId()

// ── RECIPES ──────────────────────────────────────────────────────────────────
export async function fetchRecipes() {
  const { data } = await supabase.from('recipes').select('*').eq('user_id', uid()).order('created_at', { ascending: false })
  return data || []
}
export async function saveRecipe(recipe) {
  const row = {
    user_id: uid(),
    name: recipe.name,
    ingredients: recipe.ingredients || '',
    instructions: recipe.instructions || '',
    cooking_notes: recipe.cookingNotes || '',
    clipped_from: recipe.clippedFrom || '',
    notes: recipe.notes || '',
    tags: recipe.tags || []
  }
  if (recipe.id && typeof recipe.id === 'string' && recipe.id.includes('-')) {
    const { data } = await supabase.from('recipes').update(row).eq('id', recipe.id).select()
    return data?.[0]
  } else {
    const { data } = await supabase.from('recipes').insert(row).select()
    return data?.[0]
  }
}
export async function updateRecipe(id, fields) {
  const mapped = {}
  if (fields.name !== undefined) mapped.name = fields.name
  if (fields.ingredients !== undefined) mapped.ingredients = fields.ingredients
  if (fields.instructions !== undefined) mapped.instructions = fields.instructions
  if (fields.cookingNotes !== undefined) mapped.cooking_notes = fields.cookingNotes
  if (fields.notes !== undefined) mapped.notes = fields.notes
  const { data } = await supabase.from('recipes').update(mapped).eq('id', id).select()
  return data?.[0]
}
export async function deleteRecipe(id) {
  await supabase.from('recipes').delete().eq('id', id)
}

// ── PANTRY ───────────────────────────────────────────────────────────────────
export async function fetchPantry() {
  const { data } = await supabase.from('pantry').select('*').eq('user_id', uid()).order('name')
  return data || []
}
export async function addPantryItem(name, qty, tags) {
  const { data } = await supabase.from('pantry').insert({ user_id: uid(), name, qty: qty || '', tags: tags || [] }).select()
  return data?.[0]
}
export async function updatePantryItem(id, fields) {
  const data = typeof fields === 'object' ? fields : { qty: fields }
  await supabase.from('pantry').update(data).eq('id', id)
}
export async function deletePantryItem(id) {
  await supabase.from('pantry').delete().eq('id', id)
}
export async function clearPantry() {
  await supabase.from('pantry').delete().eq('user_id', uid())
}

// ── SHOP LIST ─────────────────────────────────────────────────────────────────
export async function fetchShopList() {
  const { data } = await supabase.from('shop_list').select('*').eq('user_id', uid()).order('created_at')
  return data || []
}
export async function addShopItem(name, fromRecipe, tags) {
  const { data } = await supabase.from('shop_list').insert({ user_id: uid(), name, from_recipe: fromRecipe || '', have: false, tags: tags || [] }).select()
  return data?.[0]
}
export async function updateShopItem(id, fields) {
  const data = typeof fields === 'object' ? fields : { have: fields }
  await supabase.from('shop_list').update(data).eq('id', id)
}
export async function deleteShopItem(id) {
  await supabase.from('shop_list').delete().eq('id', id)
}
export async function clearShopList() {
  await supabase.from('shop_list').delete().eq('user_id', uid())
}
export async function markAllGotIt(items, pantryItems) {
  // Mark all as have
  const ids = items.filter(i => !i.have).map(i => i.id)
  if (ids.length) await supabase.from('shop_list').update({ have: true }).in('id', ids)
  // Add to pantry
  const toAdd = items.filter(i => !i.have && !pantryItems.find(p => p.name.toLowerCase() === i.name.toLowerCase()))
  if (toAdd.length) {
    await supabase.from('pantry').insert(toAdd.map(i => ({ user_id: uid(), name: i.name, qty: '' })))
  }
}

// ── WEIGHT LOG ────────────────────────────────────────────────────────────────
export async function fetchWeightLog() {
  const { data } = await supabase.from('weight_log').select('*').eq('user_id', uid()).order('logged_at', { ascending: true })
  return data || []
}
export async function addWeightEntry(weight, notes, dateStr) {
  const logged_at = dateStr ? new Date(dateStr + 'T12:00:00').toISOString() : new Date().toISOString()
  const { data } = await supabase.from('weight_log').insert({ user_id: uid(), weight, notes: notes || '', logged_at }).select()
  return data?.[0]
}
export async function deleteWeightEntry(id) {
  await supabase.from('weight_log').delete().eq('id', id).eq('user_id', uid())
}

// ── EXERCISE LOG ──────────────────────────────────────────────────────────────
export async function fetchLogForDate(dateStr) {
  const start = new Date(dateStr + 'T00:00:00')
  const end = new Date(dateStr + 'T23:59:59')
  const { data } = await supabase.from('food_log').select('*').eq('user_id', uid())
    .gte('logged_at', start.toISOString()).lte('logged_at', end.toISOString()).order('logged_at')
  return data || []
}
export async function fetchExerciseForDate(dateStr) {
  const start = new Date(dateStr + 'T00:00:00')
  const end = new Date(dateStr + 'T23:59:59')
  const { data } = await supabase.from('exercise_log').select('*').eq('user_id', uid())
    .gte('logged_at', start.toISOString()).lte('logged_at', end.toISOString()).order('logged_at')
  return data || []
}
export async function fetchExerciseLog() {
  const now = new Date()
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  const { data } = await supabase.from('exercise_log').select('*').eq('user_id', uid()).gte('logged_at', localMidnight.toISOString()).order('logged_at')
  return data || []
}
export async function addExerciseEntry(activity, calories_burned, breakdown, dateStr) {
  const logged_at = dateStr ? new Date(dateStr + 'T12:00:00').toISOString() : new Date().toISOString()
  const { data } = await supabase.from('exercise_log').insert({ user_id: uid(), activity, calories_burned: calories_burned || 0, breakdown: breakdown || '', logged_at }).select()
  return data?.[0]
}
export async function deleteExerciseEntry(id) {
  await supabase.from('exercise_log').delete().eq('id', id).eq('user_id', uid())
}
export async function fetchLog() {
  // Use local midnight to avoid timezone issues where yesterday's entries bleed into today
  const now = new Date()
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  const { data } = await supabase.from('food_log').select('*').eq('user_id', uid()).gte('logged_at', localMidnight.toISOString()).order('logged_at')
  return data || []
}
export async function addLogEntry(food, calories, recipeId, dateStr) {
  const row = { user_id: uid(), food, calories }
  if (recipeId) row.recipe_id = recipeId
  if (dateStr) {
    // Set logged_at to noon on the specified date in local time
    const d = new Date(dateStr + 'T12:00:00')
    row.logged_at = d.toISOString()
  }
  const { data } = await supabase.from('food_log').insert(row).select()
  return data?.[0]
}
export async function deleteLogEntry(id) {
  await supabase.from('food_log').delete().eq('id', id)
}
export async function updateLogEntry(id, fields) {
  await supabase.from('food_log').update(fields).eq('id', id)
}

// ── GOALS ─────────────────────────────────────────────────────────────────────
export async function fetchGoals() {
  const { data } = await supabase.from('goals').select('*').eq('user_id', uid())
  return data?.[0] || null
}
export async function saveGoals(goals) {
  const row = {
    user_id: uid(),
    calories: goals.calories,
    protein: goals.protein,
    carbs: goals.carbs,
    fat: goals.fat,
    goal_type: goals.goal,
    weight: goals.weight || null,
    age: goals.age || null,
    height_inches: goals.height_inches || null,
    activity_level: goals.activity_level || 'moderate',
    target_weight: goals.target_weight || null,
    goal_start_date: goals.goal_start_date || null,
    updated_at: new Date().toISOString()
  }
  const { data: existing } = await supabase.from('goals').select('id').eq('user_id', uid())
  if (existing?.length) {
    await supabase.from('goals').update(row).eq('user_id', uid())
  } else {
    await supabase.from('goals').insert(row)
  }
}

// ── TAGS ─────────────────────────────────────────────────────────────────────
export async function fetchTags(namespace) {
  const q = namespace ? `?user_id=eq.${uid()}&namespace=eq.${namespace}&order=name` : `?user_id=eq.${uid()}&order=name`
  const { data } = await supabase.from('tags').select('*').eq('user_id', uid())
  if (namespace) return (data || []).filter(t => t.namespace === namespace)
  return data || []
}
export async function saveTag(name, namespace) {
  const { data } = await supabase.from('tags').upsert({ user_id: uid(), name, namespace }, { onConflict: 'user_id,name,namespace' }).select()
  return data?.[0]
}
export async function deleteTag(id) {
  await supabase.from('tags').delete().eq('id', id)
}

// Update recipe tags
export async function updateRecipeTags(id, tags) {
  await supabase.from('recipes').update({ tags }).eq('id', id)
}
// Update pantry tags
export async function updatePantryTags(id, tags) {
  await supabase.from('pantry').update({ tags }).eq('id', id)
}
// Update shop item tags
export async function updateShopItemTags(id, tags) {
  await supabase.from('shop_list').update({ tags }).eq('id', id)
}

// ── MEAL PLAN ─────────────────────────────────────────────────────────────────
export async function fetchMealPlan(startDate, endDate) {
  const { data } = await supabase.from('meal_plan')
    .select('*')
    .eq('user_id', uid())
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date')
  return data || []
}
export async function saveMealPlanEntry(date, mealSlot, recipeId, recipeName, notes) {
  const { data } = await supabase.from('meal_plan').insert({
    user_id: uid(), date, meal_slot: mealSlot,
    recipe_id: recipeId || null, recipe_name: recipeName || '', notes: notes || ''
  }).select()
  return data?.[0]
}
export async function deleteMealPlanEntry(id) {
  await supabase.from('meal_plan').delete().eq('id', id)
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
export async function fetchFullLog(days) {
  const since = new Date()
  since.setDate(since.getDate() - (days || 90))
  const { data } = await supabase.from('food_log')
    .select('*')
    .eq('user_id', uid())
    .gte('logged_at', since.toISOString())
    .order('logged_at', { ascending: false })
  return data || []
}

export async function fetchFullMealPlan(days) {
  const since = new Date()
  since.setDate(since.getDate() - (days || 90))
  const sinceDate = since.toISOString().slice(0,10)
  const { data } = await supabase.from('meal_plan')
    .select('*')
    .eq('user_id', uid())
    .gte('date', sinceDate)
    .order('date', { ascending: false })
  return data || []
}
