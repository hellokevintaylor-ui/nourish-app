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
    tags: recipe.tags || [],
    prep_time: recipe.prep_time || null
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
  if (fields.prep_time !== undefined) mapped.prep_time = fields.prep_time
  const { data } = await supabase.from('recipes').update(mapped).eq('id', id).select()
  return data?.[0]
}
export async function archiveRecipe(id, archived) {
  await supabase.from('recipes').update({ archived: !!archived }).eq('id', id)
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
  const ids = items.filter(i => !i.have).map(i => i.id)
  if (ids.length) await supabase.from('shop_list').update({ have: true }).in('id', ids)
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
export async function updateWeightEntry(id, weight) {
  const { data } = await supabase.from('weight_log').update({ weight }).eq('id', id).eq('user_id', uid()).select()
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
  const now = new Date()
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  const { data } = await supabase.from('food_log').select('*').eq('user_id', uid()).gte('logged_at', localMidnight.toISOString()).order('logged_at')
  return data || []
}
export async function addLogEntry(food, calories, recipeId, dateStr) {
  const row = { user_id: uid(), food, calories }
  if (recipeId) row.recipe_id = recipeId
  if (dateStr) {
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
  const { data } = await supabase.from('tags').select('*').eq('user_id', uid())
  if (namespace) return (data || []).filter(t => t.namespace === namespace)
  return data || []
}
export async function saveTag(name, namespace, tagType) {
  const { data } = await supabase.from('tags').upsert({ user_id: uid(), name, namespace, tag_type: tagType || 'category' }, { onConflict: 'user_id,name,namespace' }).select()
  return data?.[0]
}

export async function updateTagType(id, tagType) {
  await supabase.from('tags').update({ tag_type: tagType }).eq('id', id)
}
export async function deleteTag(id) {
  await supabase.from('tags').delete().eq('id', id)
}
export async function updateRecipeTags(id, tags) {
  await supabase.from('recipes').update({ tags }).eq('id', id)
}
export async function updatePantryTags(id, tags) {
  await supabase.from('pantry').update({ tags }).eq('id', id)
}
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
export async function fetchFullExerciseLog(days) {
  const since = new Date()
  since.setDate(since.getDate() - (days || 30))
  const { data } = await supabase.from('exercise_log')
    .select('*')
    .eq('user_id', uid())
    .gte('logged_at', since.toISOString())
    .order('logged_at', { ascending: false })
  return data || []
}
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

// ── RECIPE CHATS ──────────────────────────────────────────────────────────────
export async function fetchRecipeChat(recipeId) {
  const { data } = await supabase.from('recipe_chats')
    .select('*')
    .eq('user_id', uid())
    .eq('recipe_id', recipeId)
    .single()
  return data?.messages || []
}

export async function saveRecipeChat(recipeId, messages) {
  await supabase.from('recipe_chats')
    .upsert({
      user_id: uid(),
      recipe_id: recipeId,
      messages,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,recipe_id' })
}
export async function fetchGamePlans() {
  const { data } = await supabase.from('game_plans')
    .select('*')
    .eq('user_id', uid())
    .order('updated_at', { ascending: false })
  return data || []
}

export async function saveGamePlan(date, slot, timeline, chatMessages, targetTime) {
  const row = {
    user_id: uid(),
    date,
    slot,
    timeline: timeline || null,
    chat_messages: chatMessages || [],
    target_time: targetTime || null,
    updated_at: new Date().toISOString()
  }
  // Upsert — update if same user/date/slot exists, insert if not
  const { data } = await supabase.from('game_plans')
    .upsert(row, { onConflict: 'user_id,date,slot' })
    .select()
  return data?.[0]
}

export async function deleteGamePlan(date, slot) {
  await supabase.from('game_plans')
    .delete()
    .eq('user_id', uid())
    .eq('date', date)
    .eq('slot', slot)
}
