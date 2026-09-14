/**
 * The check-in beep, and the two rules that decide when it plays.
 *
 * Four screens can beep when a student checks in: the student's own phone, the
 * presenter tab, the shared display link and the TA dashboard. The sound lives
 * here once so they all sound alike, and the rules are pure functions so
 * `npm run test:attendance` can pin them.
 *
 * WHY A TONE AND NOT AN AUDIO FILE
 *
 * A short sine tone from the Web Audio API needs no asset to download, cannot
 * fail to load on a slow network, and plays the instant it is asked.
 *
 * BROWSERS BLOCK SOUND UNTIL THE PAGE IS TAPPED
 *
 * Every major browser keeps audio silent until someone has interacted with the
 * page. primeSound() must therefore be called from inside a tap, click or key
 * press — a mute toggle, a submit button, the first tap on a dashboard. A
 * screen that nobody has touched since it loaded stays quiet, whatever its
 * saved setting says; useSoundPreference arranges for the first tap to count.
 */

// ---------------------------------------------------------------------------
// The rules (pure)
// ---------------------------------------------------------------------------

const PRESENT = new Set(["present", "late"]);

/** A row as realtime delivers it. Every field optional: DELETE sends only keys. */
interface RecordLike {
  marked_by_role?: unknown;
  state?: unknown;
  session_id?: unknown;
}

/** The shape of a realtime postgres_changes payload, as far as this needs it. */
export interface RecordChange {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: RecordLike | null;
  old: RecordLike | null;
}

const isStudentPresent = (row: RecordLike | null): boolean =>
  !!row && row.marked_by_role === "student" && PRESENT.has(row.state as string);

/**
 * Whether a change to attendance_records is a student checking in.
 *
 * A TA's mark is not ('staff'), nor an absence written when a session closes
 * ('system'), nor an update to a check-in that already happened. Since
 * migration 044 a check-in over an existing row is stored as 'student', so an
 * UPDATE counts when the row BECOMES a student's present or late mark.
 */
export const isStudentCheckIn = (change: RecordChange): boolean => {
  if (!isStudentPresent(change.new)) return false;
  if (change.eventType === "INSERT") return true;
  if (change.eventType !== "UPDATE") return false;
  return !isStudentPresent(change.old);
};

export interface CountedSession {
  id: string;
  /** Students who checked themselves in. From get_class_display (044). */
  checked_in: number;
}

/** The counts to compare the next poll against. */
export const checkInCounts = (sessions: CountedSession[]): Map<string, number> =>
  new Map(sessions.map((s) => [s.id, s.checked_in]));

/**
 * How many check-ins arrived between two polls of the signed-out display.
 *
 * Nothing on the first look: a screen switched on halfway through a class
 * should not beep for everyone who arrived before it. The same for a session
 * that was not on screen last time. A count that went down — a TA correcting a
 * mark — is not a check-in either.
 */
export const newCheckIns = (
  previous: ReadonlyMap<string, number> | null,
  sessions: CountedSession[],
): number => {
  if (!previous) return 0;
  return sessions.reduce((sum, s) => {
    const before = previous.get(s.id);
    if (before === undefined) return sum;
    return sum + Math.max(0, s.checked_in - before);
  }, 0);
};

// ---------------------------------------------------------------------------
// The sound
// ---------------------------------------------------------------------------

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

const audio = (): AudioContext | null => {
  if (context) return context;
  if (typeof window === "undefined") return null;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
};

/** Call from inside a tap, click or key press, so later beeps are allowed. */
export const primeSound = (): void => {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
};

/**
 * One short beep, or up to three in a row for several check-ins at once.
 * Capped: forty students scanning in the same second is one room's noise, not
 * forty beeps.
 */
export const playCheckInBeep = (times = 1): void => {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

  const count = Math.min(Math.max(Math.floor(times), 1), 3);
  for (let i = 0; i < count; i += 1) {
    const start = ctx.currentTime + i * 0.18;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    // A fast rise and fall, so it is a clean blip rather than a click.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.16);
  }
};
