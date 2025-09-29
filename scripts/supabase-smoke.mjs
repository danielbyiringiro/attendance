import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(url, key)

const studentId = `TEST_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
const cohort = Math.random() > 0.5 ? 'B' : 'C'
const timestamp = new Date().toISOString()

try {
  const { error: insertError } = await supabase
    .from('present_students')
    .insert({ student_id: studentId, cohort, timestamp })

  if (insertError) throw insertError

  const { data, error: selectError } = await supabase
    .from('present_students')
    .select('student_id, cohort, timestamp')
    .eq('student_id', studentId)
    .order('timestamp', { ascending: false })
    .limit(1)

  if (selectError) throw selectError

  console.log(JSON.stringify({ ok: true, inserted: { student_id: studentId, cohort, timestamp }, fetched: data?.[0] }, null, 2))
} catch (e) {
  console.error('Supabase smoke test failed:', e)
  process.exit(2)
}




