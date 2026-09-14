/**
 * The check-in chime, and the two rules that decide when it plays.
 *
 * Four screens can chime when a student checks in: the student's own phone,
 * the presenter tab, the shared display link and the TA dashboard. The sound
 * lives here once so they all sound alike, and the rules are pure functions so
 * `npm run test:attendance` can pin them.
 *
 * THE SOUND
 *
 * A two-note "ba-ding", like a phone notification: a short lower note, then a
 * higher one that rings out. Each note is a small bell — a fundamental plus two
 * quieter overtones that die away faster, one of them deliberately
 * out of tune (2.76×), which is what makes a struck bell sound like a bell
 * rather than a whistle.
 *
 * Built from the Web Audio API rather than an audio file: nothing to download,
 * nothing that can fail to load on a slow network, and it plays the instant it
 * is asked.
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
 * should not chime for everyone who arrived before it. The same for a session
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

/** Call from inside a tap, click or key press, so later chimes are allowed. */
export const primeSound = (): void => {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
};

/** One sine partial: a near-instant strike, then an exponential ring-out. */
const partial = (
  ctx: AudioContext,
  out: AudioNode,
  freq: number,
  start: number,
  ring: number,
  peak: number,
) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + ring);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + ring + 0.05);
};

/** A small struck bell: the note, and two overtones that fade sooner. */
const bell = (
  ctx: AudioContext,
  out: AudioNode,
  freq: number,
  start: number,
  ring: number,
  peak: number,
) => {
  partial(ctx, out, freq, start, ring, peak);
  partial(ctx, out, freq * 2, start, ring * 0.5, peak * 0.18);
  partial(ctx, out, freq * 2.76, start, ring * 0.3, peak * 0.12);
};

/** B5 then E6: a rising fourth, the shape most notification sounds use. */
const BA = 987.77;
const DING = 1318.51;

/**
 * The "ba-ding". For several check-ins at once, the ding repeats — up to two
 * more times, quieter — rather than stacking whole chimes. Forty students
 * scanning in the same second is one room's noise, not forty chimes.
 */
export const playCheckInBeep = (times = 1): void => {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

  // One level for the whole chime. 2.4 puts its loudest instant at about two
  // thirds of full scale — as present as a phone notification — and leaves
  // headroom, so the repeated dings for several check-ins still cannot clip.
  const master = ctx.createGain();
  master.gain.value = 2.4;
  master.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.02;
  bell(ctx, master, BA, t0, 0.22, 0.2);
  bell(ctx, master, DING, t0 + 0.12, 1.2, 0.24);

  const extra = Math.min(Math.max(Math.floor(times), 1), 3) - 1;
  for (let i = 1; i <= extra; i += 1) {
    bell(ctx, master, DING, t0 + 0.12 + i * 0.32, 0.9, 0.16);
  }
};
