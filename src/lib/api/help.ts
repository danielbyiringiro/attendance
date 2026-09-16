// The Help screen: videos to watch, and what has changed lately.
//
// Videos link out — nothing is embedded. Announcements carry whether the
// signed-in account has read them, which is why read state lives on the server
// rather than in this browser's storage: the dot has to follow the person.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

export interface HelpVideo {
  id: string;
  title: string;
  /** Always http(s) — the server refuses anything else (049). */
  url: string;
  description: string | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  posted_at: string;
  /** For this account, on any device. Read ones stay listed. */
  read: boolean;
}

export interface HelpContent {
  videos: HelpVideo[];
  announcements: Announcement[];
  /** What the sidebar dot counts. */
  unread: number;
}

/** Everything the Help screen shows, in one call. */
export const getHelp = async (): Promise<HelpContent> => {
  const { data, error } = await supabase.rpc("get_help");
  if (error) fail("Could not load Help", error);
  return data as HelpContent;
};

/**
 * Mark announcements read for the signed-in account.
 *
 * No argument means all of them. Reading twice is not a second event, so
 * calling this on every visit to Help is safe and is exactly how it is used.
 */
export const markAnnouncementsRead = async (
  ids?: string[],
): Promise<number> => {
  const { data, error } = await supabase.rpc("mark_announcements_read", {
    p_ids: ids ?? null,
  });
  if (error) fail("Could not mark these as read", error);
  return (data as number) ?? 0;
};

/**
 * Add a video, or change one. Admin only — the server checks.
 *
 * `id` absent adds; present edits. A description sent as "" is cleared, and one
 * left undefined is kept, because "remove the description" has to be sayable.
 */
export const adminSetHelpVideo = async (input: {
  id?: string;
  title?: string;
  url?: string;
  description?: string;
  sortOrder?: number;
}): Promise<HelpVideo> => {
  const { data, error } = await supabase.rpc("admin_set_help_video", {
    p_id: input.id ?? null,
    p_title: input.title ?? null,
    p_url: input.url ?? null,
    p_description: input.description ?? null,
    p_sort_order: input.sortOrder ?? null,
  });
  if (error) fail("Could not save the video", error);
  return data as HelpVideo;
};

export const adminDeleteHelpVideo = async (id: string): Promise<boolean> => {
  const { data, error } = await supabase.rpc("admin_delete_help_video", {
    p_id: id,
  });
  if (error) fail("Could not remove the video", error);
  return Boolean(data);
};

/** Post a notice. Deliberately not an upsert — see 049. */
export const adminPostAnnouncement = async (
  title: string,
  body: string,
): Promise<Announcement> => {
  const { data, error } = await supabase.rpc("admin_post_announcement", {
    p_title: title,
    p_body: body,
  });
  if (error) fail("Could not post the announcement", error);
  return data as Announcement;
};

/**
 * Fix a posted notice.
 *
 * Does not move its date and does not un-read it for anybody who has already
 * seen it: a typo is not news.
 */
export const adminEditAnnouncement = async (
  id: string,
  changes: { title?: string; body?: string },
): Promise<Announcement> => {
  const { data, error } = await supabase.rpc("admin_edit_announcement", {
    p_id: id,
    p_title: changes.title ?? null,
    p_body: changes.body ?? null,
  });
  if (error) fail("Could not change the announcement", error);
  return data as Announcement;
};

export const adminDeleteAnnouncement = async (id: string): Promise<boolean> => {
  const { data, error } = await supabase.rpc("admin_delete_announcement", {
    p_id: id,
  });
  if (error) fail("Could not remove the announcement", error);
  return Boolean(data);
};
