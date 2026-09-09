import { useId } from "react";

interface LogoProps {
  className?: string;
  /** Drop the register rules, as the favicon does. For small sizes. */
  simple?: boolean;
}

/**
 * The mark: a register with one name answered.
 *
 * Inline rather than an <img src="/logo.svg">, for two reasons. The gradient
 * has to be painted with the app's own colours rather than a copy that drifts
 * from them, and an inline node can be sized by a className like every other
 * icon here.
 *
 * useId for the gradient, because two of these on one page with the same id
 * means the second one silently paints with the first one's gradient — and
 * they are the same gradient today, which is exactly how that bug survives
 * until they are not.
 */
const Logo = ({ className = "h-8 w-8", simple = false }: LogoProps) => {
  const gradientId = useId();

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="Attendance"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="hsl(var(--primary))" />
          <stop offset="1" stopColor="hsl(var(--accent))" />
        </linearGradient>
      </defs>

      <rect width="64" height="64" rx="14" fill={`url(#${gradientId})`} />

      {simple ? (
        <path
          d="M16 33l11 11 21-24"
          fill="none"
          stroke="hsl(var(--primary-foreground))"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <g stroke="hsl(var(--primary-foreground))" strokeLinecap="round" fill="none">
          {/* Two names on the register. */}
          <path d="M16 24h13" strokeWidth="4" opacity="0.55" />
          <path d="M16 34h9" strokeWidth="4" opacity="0.55" />
          {/* The one that has been called. */}
          <path
            d="M22 45.5l7 7 16.5-19"
            strokeWidth="6"
            strokeLinejoin="round"
          />
        </g>
      )}
    </svg>
  );
};

export default Logo;
