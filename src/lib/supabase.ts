import { createClient } from "@supabase/supabase-js";

// Hardcoded for demo purposes only
const supabaseUrl = "https://ostozdfvnjiamtuyjemh.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zdG96ZGZ2bmppYW10dXlqZW1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMTAzNzQsImV4cCI6MjA5NDY4NjM3NH0.vmYN_sSWfYkQzyWUk_mTaDzDBL6p2t50z6snVEt5ovI";
const supabase_service_role =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zdG96ZGZ2bmppYW10dXlqZW1oIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTExMDM3NCwiZXhwIjoyMDk0Njg2Mzc0fQ.vq-YzkUliNGmqW67vCc1MRAirSFjWTYhXcBoxh2O294";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseServiceRole = createClient(
  supabaseUrl,
  supabase_service_role,
);
