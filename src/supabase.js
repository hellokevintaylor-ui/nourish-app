import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Generate or retrieve a stable user ID (no auth needed)
export function getUserId() {
  let uid = localStorage.getItem('nourish_uid')
  if (!uid) {
    uid = 'user_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem('nourish_uid', uid)
  }
  return uid
}
