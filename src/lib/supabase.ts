import { createClient } from "@supabase/supabase-js";

// Hardcoded for demo purposes only
const supabaseUrl = "https://fvhatekwtapspadtlmcn.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2aGF0ZWt3dGFwc3BhZHRsbWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MTg3NzEsImV4cCI6MjA3NDI5NDc3MX0.Pa5SLoqQ-6cOS2Ijyg_atbyztKvUlDeyO8EIsJqUew8";
const supabase_service_role =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2aGF0ZWt3dGFwc3BhZHRsbWNuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1ODcxODc3MSwiZXhwIjoyMDc0Mjk0NzcxfQ.rZYlz0gY_DhgLxGgTKye3VNWyqrXD9FFulUjb1j-pv0";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseServiceRole = createClient(
  supabaseUrl,
  supabase_service_role,
);

const cohort = "C"; // replace with your actual cohort

const datesToCancel = ["2026-03-18"];

const insertData = datesToCancel.map((date) => ({
  cohort,
  date,
  is_cancelled: true,
}));

const { data, error } = await supabaseServiceRole
  .from("students")
  .select("*")
  .ilike("name", "daisy*");

console.log("upserted cancelled sessions:", data);
console.log("error:", error);
