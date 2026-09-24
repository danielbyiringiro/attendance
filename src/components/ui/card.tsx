import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Card padding steps with the screen, the way the dialogs already do.
 *
 * Stock shadcn sets a flat p-6 — 24px on every side at every width. On a
 * 360px phone that is 48px of the screen spent on the card's own inset,
 * before anything inside it has a say, and the app stacks these cards inside
 * a page that has its own padding again. Rows of a register went narrow
 * enough to wrap names that fit perfectly well.
 *
 * Several screens had already worked around it locally with p-4 or py-4
 * overrides, which is the same fix applied four times and disagreeing with
 * itself. ui/dialog.tsx and ui/alert-dialog.tsx solved it properly with
 * p-4 sm:p-6; this is that, in the one place the rest of the app inherits
 * from.
 *
 * WHY THE BODY REPEATS pt-0 AT BOTH STEPS
 *
 * Content and footer sit under a header that has already paid for the gap, so
 * stock shadcn zeroes their top with "p-6 pt-0". Writing that here as
 * "p-4 sm:p-6 pt-0" would break above 640px: Tailwind emits every sm: utility
 * after every unprefixed one, so sm:p-6 lands later in the stylesheet than
 * pt-0 and quietly puts the top padding back on desktop only. The zero has to
 * be stated at both steps, or the bug is invisible on the machine it is
 * written on and obvious on everybody else's.
 */
/**
 * Padding for a CardContent with **no CardHeader above it**.
 *
 * CardContent zeroes its own top because normally a header has already paid
 * for that gap. Six headerless cards had each restored it by hand — `pt-6`,
 * `py-4`, `p-4` — three different answers to one question, and all three
 * would now be wrong above 640px, since an unprefixed override cannot beat
 * the sm: rules it is trying to replace (see above). This is the answer, in
 * one place, stated at both steps so it actually wins:
 *
 *     <CardContent className={cn(CARD_PADDING_NO_HEADER, "space-y-3")}>
 *
 * It is the same value the header and the card's own edges use; the literal is
 * written here rather than derived so the lint rule can see it is a constant
 * and the export does not cost this file its fast refresh.
 */
export const CARD_PADDING_NO_HEADER = "p-4 sm:p-6";

const PAD = CARD_PADDING_NO_HEADER;
const PAD_BELOW_HEADER = "p-4 pt-0 sm:p-6 sm:pt-0";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5", PAD, className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn(PAD_BELOW_HEADER, className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center", PAD_BELOW_HEADER, className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
