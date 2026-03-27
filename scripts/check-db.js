import { createClient } from "@supabase/supabase-js";
const supabaseUrl = "https://fvhatekwtapspadtlmcn.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2aGF0ZWt3dGFwc3BhZHRsbWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MTg3NzEsImV4cCI6MjA3NDI5NDc3MX0.Pa5SLoqQ-6cOS2Ijyg_atbyztKvUlDeyO8EIsJqUew8";
const supabase = createClient(supabaseUrl, supabaseAnonKey);
async function run() {
  const { data, error } = await supabase.from('sessions').select('*').limit(1);
  console.log(error ? error : "Sessions: " + data.length);
}
run();
